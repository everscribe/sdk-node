import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { current, Event, newFromContext, prepareEvent } from "../src/event/event.js";
import {
  type GrpcCallInfo,
  grpcServerInterceptor,
  httpStatusForGrpcCode,
  resultFromGrpcStatus,
} from "../src/grpc.js";
import type { Recorder } from "../src/recorder/types.js";

/** Minimal JSON-over-grpc service, built without protoc/proto-loader - the
 *  same "define the wire format inline" approach the spike used. Every
 *  method is unary; that is the whole surface this adapter supports. */
function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value ?? {}));
}
function decode<T>(buf: Buffer): T {
  return JSON.parse(buf.length > 0 ? buf.toString("utf8") : "{}") as T;
}

function unaryMethod(path: string): grpc.ServerMethodDefinition<unknown, unknown> &
  grpc.ClientMethodDefinition<unknown, unknown> {
  return {
    path,
    requestStream: false,
    responseStream: false,
    requestSerialize: encode,
    requestDeserialize: decode,
    responseSerialize: encode,
    responseDeserialize: decode,
  };
}

const serviceDefinition: grpc.ServiceDefinition = {
  ping: unaryMethod("/test.TestService/Ping"),
  setAction: unaryMethod("/test.TestService/SetAction"),
  deny: unaryMethod("/test.TestService/Deny"),
  clone: unaryMethod("/test.TestService/Clone"),
  delay: unaryMethod("/test.TestService/Delay"),
};

type UnaryImpl = (
  call: grpc.ServerUnaryCall<unknown, unknown>,
  callback: grpc.sendUnaryData<unknown>,
) => void;

interface Harness {
  client: grpc.Client & Record<string, (...args: unknown[]) => unknown>;
  records: Event[];
  recorder: Recorder;
  recordDone: () => Promise<Event>;
  close(): Promise<void>;
}

async function startGrpcServer(
  implementation: Partial<Record<keyof typeof serviceDefinition, UnaryImpl>>,
  opts: {
    recorder?: Recorder | null;
    resolveActor?: (info: GrpcCallInfo) => { type: string; id?: string; displayName?: string };
  } = {},
): Promise<Harness> {
  const records: Event[] = [];
  let resolveNext: ((e: Event) => void) | null = null;
  const defaultRecorder: Recorder = {
    async record(e: Event) {
      records.push(e);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(e);
      }
    },
  };
  // null means "no recorder at all"; undefined (the common case) means "use
  // the harness's own recorder, tracked via records/recordDone"; anything
  // else is a caller-supplied recorder (e.g. one that also calls
  // prepareEvent, to exercise the manual-record dedupe path).
  const rec = opts.recorder === null ? undefined : (opts.recorder ?? defaultRecorder);

  const server = new grpc.Server({
    interceptors: [grpcServerInterceptor({ recorder: rec, resolveActor: opts.resolveActor })],
  });
  server.addService(serviceDefinition, implementation as grpc.UntypedServiceImplementation);

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });

  const ClientCtor = grpc.makeClientConstructor(serviceDefinition, "TestService");
  const client = new ClientCtor(
    `127.0.0.1:${port}`,
    grpc.ChannelCredentials.createInsecure(),
  ) as grpc.Client & Record<string, (...args: unknown[]) => unknown>;

  return {
    client,
    records,
    recorder: defaultRecorder,
    recordDone: () =>
      new Promise<Event>((resolve) => {
        if (records.length > 0) resolve(records[records.length - 1]!);
        else resolveNext = resolve;
      }),
    async close() {
      client.close();
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    },
  };
}

/** Promisified unary call. Optionally attaches metadata (e.g. to exercise
 *  resolveActor/origin) - grpc-js's callback-style client always accepts
 *  metadata as the middle argument when supplied. */
function callUnary<Req = unknown, Res = unknown>(
  client: grpc.Client & Record<string, (...args: unknown[]) => unknown>,
  method: string,
  req: Req,
  metadata?: grpc.Metadata,
): Promise<{ error: grpc.ServiceError | null; response: Res | undefined }> {
  return new Promise((resolve) => {
    const callback = (error: grpc.ServiceError | null, response: Res) => resolve({ error, response });
    if (metadata) {
      client[method]!(req, metadata, callback);
    } else {
      client[method]!(req, callback);
    }
  });
}

let h: Harness | undefined;

afterEach(async () => {
  if (h) {
    try {
      await h.close();
    } finally {
      h = undefined;
    }
  }
});

describe("resultFromGrpcStatus / httpStatusForGrpcCode: the 17-code mapping", () => {
  // Exhaustive over every gRPC status code grpc-js defines - mirrors
  // sdk-go's TestHTTPStatusFor table (adapter_codes_test.go) case for case.
  const table: Array<{ code: grpc.status; want: number }> = [
    { code: grpc.status.OK, want: 200 },
    { code: grpc.status.CANCELLED, want: 499 },
    { code: grpc.status.UNKNOWN, want: 500 },
    { code: grpc.status.INVALID_ARGUMENT, want: 400 },
    { code: grpc.status.DEADLINE_EXCEEDED, want: 504 },
    { code: grpc.status.NOT_FOUND, want: 404 },
    { code: grpc.status.ALREADY_EXISTS, want: 409 },
    { code: grpc.status.PERMISSION_DENIED, want: 403 },
    { code: grpc.status.RESOURCE_EXHAUSTED, want: 429 },
    { code: grpc.status.FAILED_PRECONDITION, want: 400 },
    { code: grpc.status.ABORTED, want: 409 },
    { code: grpc.status.OUT_OF_RANGE, want: 400 },
    { code: grpc.status.UNIMPLEMENTED, want: 501 },
    { code: grpc.status.INTERNAL, want: 500 },
    { code: grpc.status.UNAVAILABLE, want: 503 },
    { code: grpc.status.DATA_LOSS, want: 500 },
    { code: grpc.status.UNAUTHENTICATED, want: 401 },
  ];

  it("covers all 17 gRPC status codes", () => {
    expect(table).toHaveLength(17);
  });

  it.each(table)("$code -> $want", ({ code, want }) => {
    expect(httpStatusForGrpcCode(code)).toBe(want);
  });

  it("OK maps to 200, never to the native 0", () => {
    const result = resultFromGrpcStatus(grpc.status.OK, "OK");
    expect(result.status).toBe("ok");
    expect(result.code).toBe(200);
    expect(result.code).not.toBe(0);
    // OK never carries grpc-js's own boilerplate "OK" details as a message -
    // see resultFromGrpcStatus's doc comment for why.
    expect(result.message).toBeUndefined();
  });

  it("PERMISSION_DENIED and UNAUTHENTICATED map to denied", () => {
    expect(resultFromGrpcStatus(grpc.status.PERMISSION_DENIED, "").status).toBe("denied");
    expect(resultFromGrpcStatus(grpc.status.UNAUTHENTICATED, "").status).toBe("denied");
  });

  it("preserves a non-empty details string as message for non-OK codes", () => {
    const result = resultFromGrpcStatus(grpc.status.NOT_FOUND, "no such project");
    expect(result.message).toBe("no such project");
  });
});

describe("grpcServerInterceptor: actor and origin", () => {
  it("populates actor from resolveActor using request metadata", async () => {
    h = await startGrpcServer(
      {
        ping(call, callback) {
          current().action = "test";
          callback(null, {});
        },
      },
      {
        resolveActor: (info) => {
          const id = info.metadata.get("x-user-id")[0];
          return { type: "user", id: typeof id === "string" ? id : "" };
        },
      },
    );
    const md = new grpc.Metadata();
    md.set("x-user-id", "u1");
    await callUnary(h.client, "ping", {}, md);
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "user", id: "u1" });
  });

  it("defaults to anonymous when no resolver provided", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "test";
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "anonymous" });
  });

  it("derives origin from request metadata (x-forwarded-for, x-request-id)", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "test";
        callback(null, {});
      },
    });
    const md = new grpc.Metadata();
    md.set("x-forwarded-for", "1.2.3.4, 5.6.7.8");
    md.set("x-request-id", "req-abc");
    await callUnary(h.client, "ping", {}, md);
    const e = await h.recordDone();
    expect(e.origin?.ip).toBe("1.2.3.4");
    expect(e.origin?.requestId).toBe("req-abc");
  });

  it("falls back to the peer address when no forwarding metadata is present", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "test";
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.origin?.ip).toBe("127.0.0.1");
  });
});

describe("grpcServerInterceptor: current() and action defaults", () => {
  it("current() resolves inside the handler with a fresh event per call", async () => {
    const seen: string[] = [];
    h = await startGrpcServer({
      ping(_call, callback) {
        seen.push(current().id);
        current().action = "test";
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    await h.recordDone();
    await callUnary(h.client, "ping", {});
    await h.recordDone();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe("");
  });

  it("action defaults to the full RPC method name when the handler doesn't set one", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.action).toBe("/test.TestService/Ping");
  });

  it("a handler-set action wins over the method-name default", async () => {
    h = await startGrpcServer({
      setAction(_call, callback) {
        current().action = "custom.action";
        callback(null, {});
      },
    });
    await callUnary(h.client, "setAction", {});
    const e = await h.recordDone();
    expect(e.action).toBe("custom.action");
  });

  it("newFromContext() clone does NOT inherit the RPC method name", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    let cloneAction = "unset";
    h = await startGrpcServer(
      {
        clone(_call, callback) {
          // Leave the primary event's action at its method-name default.
          const sub = newFromContext();
          cloneAction = sub.action;
          sub.action = "clone.recorded";
          void recorder.record(sub);
          callback(null, {});
        },
      },
      { recorder: null },
    );
    await callUnary(h.client, "clone", {});
    await new Promise((r) => setTimeout(r, 30));
    // The clone's action, read BEFORE the handler set it explicitly, must be
    // empty - never "/test.TestService/Clone". If the template (rather than
    // the call-scoped event) had been stamped with the method name, every
    // clone would inherit it, which is exactly the bug this interceptor
    // avoids (see the doc comment on grpcServerInterceptor).
    expect(cloneAction).toBe("");
    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe("clone.recorded");
  });
});

describe("grpcServerInterceptor: auto-record", () => {
  it("records once per RPC", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "user.login";
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.action).toBe("user.login");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.records).toHaveLength(1);
  });

  it("OK records as {status: 'ok', code: 200}, never code 0", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "test";
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.result?.status).toBe("ok");
    expect(e.result?.code).toBe(200);
    expect(e.result?.code).not.toBe(0);
  });

  it("PERMISSION_DENIED records as {status: 'denied', code: 403}", async () => {
    h = await startGrpcServer({
      deny(_call, callback) {
        // action defaults to the method name; result comes from the status.
        callback({
          name: "denied",
          message: "not allowed",
          code: grpc.status.PERMISSION_DENIED,
        } as grpc.ServiceError);
      },
    });
    const { error } = await callUnary(h.client, "deny", {});
    expect(error?.code).toBe(grpc.status.PERMISSION_DENIED);
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.code).toBe(403);
  });

  it("explicit result wins over auto-capture", async () => {
    h = await startGrpcServer({
      ping(_call, callback) {
        current().action = "password.reset_requested";
        current().result = { status: "denied", message: "no account for email" };
        callback(null, {});
      },
    });
    await callUnary(h.client, "ping", {});
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.message).toBe("no account for email");
  });

  it("does not auto-record when no recorder is configured", async () => {
    const calls: Event[] = [];
    const observer: Recorder = {
      async record(e) {
        calls.push(e);
      },
    };
    h = await startGrpcServer(
      {
        ping(_call, callback) {
          current().action = "test";
          void observer.record(current());
          callback(null, {});
        },
      },
      { recorder: null },
    );
    await callUnary(h.client, "ping", {});
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  it("does not double-record when a handler manually records through the configured recorder (invariant 3)", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    h = await startGrpcServer(
      {
        ping(_call, callback) {
          current().action = "user.login";
          void recorder.record(current());
          callback(null, {});
        },
      },
      { recorder },
    );
    await callUnary(h.client, "ping", {});
    // Wait for the sendStatus auto-record backstop to have a chance to
    // (incorrectly) fire a second time.
    await new Promise((r) => setTimeout(r, 30));
    expect(records).toHaveLength(1);
  });

  it("stamps idempotencyKey on the call-scoped event but not on newFromContext() clones", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    let cloneKey: string | undefined = "unset";
    h = await startGrpcServer(
      {
        clone(_call, callback) {
          current().action = "user.login";
          const clone = newFromContext();
          clone.action = "user.login.clone";
          cloneKey = clone.idempotencyKey;
          void recorder.record(clone);
          callback(null, {});
        },
      },
      { recorder },
    );
    await callUnary(h.client, "clone", {});
    await new Promise((r) => setTimeout(r, 30));
    expect(cloneKey).toBeFalsy();
    const primary = records.find((e) => e.action === "user.login");
    expect(primary?.idempotencyKey).toBeTruthy();
    expect(primary?.idempotencyKey).toBe(primary?.id);
  });

  it("logs (does not throw) when auto-record fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingRec: Recorder = {
        async record() {
          throw new Error("boom");
        },
      };
      h = await startGrpcServer(
        {
          ping(_call, callback) {
            current().action = "test";
            callback(null, {});
          },
        },
        { recorder: failingRec },
      );
      const { error } = await callUnary(h.client, "ping", {});
      expect(error).toBeNull();
      await new Promise((r) => setTimeout(r, 30));
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("grpcServerInterceptor: concurrency", () => {
  it("does not cross-talk events between overlapping in-flight RPCs", async () => {
    h = await startGrpcServer(
      {
        delay(call, callback) {
          const req = call.request as { token: string; ms: number };
          // action doubles as this call's marker - if ALS leaked across
          // concurrent calls, a sibling's action would show up here instead.
          current().action = req.token;
          const seenAtStart = current().action;
          setTimeout(() => {
            // Re-read after the handler's own async gap - current() must
            // still resolve to this call's own event, not a sibling's.
            const seenAfterDelay = current().action;
            callback(null, { token: req.token, seenAtStart, seenAfterDelay });
          }, req.ms);
        },
      },
      {},
    );

    const calls = [
      { token: "A", ms: 60 },
      { token: "B", ms: 10 },
      { token: "C", ms: 30 },
    ];
    const results = await Promise.all(
      calls.map((c) => callUnary<typeof c, { token: string; seenAtStart: string; seenAfterDelay: string }>(h!.client, "delay", c)),
    );
    for (let i = 0; i < calls.length; i++) {
      expect(results[i]!.error).toBeNull();
      expect(results[i]!.response?.token).toBe(calls[i]!.token);
      expect(results[i]!.response?.seenAtStart).toBe(calls[i]!.token);
      expect(results[i]!.response?.seenAfterDelay).toBe(calls[i]!.token);
    }
  });
});

describe("grpcServerInterceptor: streaming is out of scope", () => {
  it("passes streaming methods through untouched instead of half-supporting them", () => {
    const interceptor = grpcServerInterceptor({});
    const streamingMethod: grpc.ServerMethodDefinition<unknown, unknown> = {
      ...unaryMethod("/test.TestService/Stream"),
      requestStream: false,
      responseStream: true,
    };
    let started = false;
    const fakeCall: grpc.ServerInterceptingCallInterface = {
      start: () => {
        started = true;
      },
      sendMetadata: () => {},
      sendMessage: () => {},
      sendStatus: () => {},
      startRead: () => {},
      getPeer: () => "unknown",
      getDeadline: () => Infinity,
      getHost: () => "",
      getAuthContext: () => ({}),
      getConnectionInfo: () => ({}),
      getMetricsRecorder: () => ({}) as ReturnType<grpc.ServerInterceptingCallInterface["getMetricsRecorder"]>,
    };
    const intercepted = interceptor(streamingMethod, fakeCall);
    intercepted.start({
      onReceiveMetadata: () => {},
      onReceiveMessage: () => {},
      onReceiveHalfClose: () => {},
      onCancel: () => {},
    });
    // A passthrough call forwards start() straight to the underlying call
    // rather than installing a listener that runs a lifecycle.
    expect(started).toBe(true);
  });
});
