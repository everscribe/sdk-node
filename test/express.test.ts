import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Event, newFromContext, prepareEvent } from "../src/event/event.js";
import { expressMiddleware } from "../src/express.js";
import type { Recorder } from "../src/recorder/types.js";

interface Harness {
  url: string;
  records: Event[];
  recorder: Recorder;
  recordDone: () => Promise<Event>;
  close(): Promise<void>;
}

async function startApp(
  configure: (app: express.Express, harness: Pick<Harness, "recorder">) => void,
  opts: { recorder?: Recorder | null } = {},
): Promise<Harness> {
  const records: Event[] = [];
  let resolveNext: ((e: Event) => void) | null = null;
  const recorder: Recorder = {
    async record(e: Event) {
      records.push(e);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(e);
      }
    },
  };
  const app = express();
  configure(app, { recorder: opts.recorder === null ? (undefined as unknown as Recorder) : recorder });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    records,
    recorder,
    recordDone: () =>
      new Promise<Event>((resolve) => {
        if (records.length > 0) resolve(records[records.length - 1]!);
        else resolveNext = resolve;
      }),
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
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

describe("expressMiddleware: actor and origin", () => {
  it("populates actor from resolveActor", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(
        expressMiddleware({
          recorder,
          resolveActor: () => ({ type: "user", id: "u1", displayName: "alice" }),
        }),
      );
      app.post("/", (req, res) => {
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "user", id: "u1", displayName: "alice" });
  });

  it("defaults to anonymous when no resolver provided", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "anonymous" });
  });

  it("derives origin from request headers", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, {
      method: "POST",
      headers: {
        "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
        "X-Request-ID": "req-abc",
        "User-Agent": "test-ua/1.0",
      },
    });
    const e = await h.recordDone();
    expect(e.origin?.ip).toBe("1.2.3.4");
    expect(e.origin?.userAgent).toBe("test-ua/1.0");
    expect(e.origin?.requestId).toBe("req-abc");
  });

  it("passes the request to resolveActor", async () => {
    let seenSession: unknown = null;
    h = await startApp((app, { recorder }) => {
      app.use((req, _res, next) => {
        (req as unknown as { session: { user: string } }).session = { user: "alice" };
        next();
      });
      app.use(
        expressMiddleware({
          recorder,
          resolveActor: (req) => {
            const s = (req as unknown as { session: { user: string } }).session;
            seenSession = s;
            return { type: "user", id: s.user };
          },
        }),
      );
      app.post("/", (req, res) => {
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(seenSession).toEqual({ user: "alice" });
    expect(e.actor.id).toBe("alice");
  });
});

describe("expressMiddleware: req.event and newFromContext", () => {
  it("installs a fresh Event on req.event for each request", async () => {
    const seen: string[] = [];
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        seen.push(req.event!.id);
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("newFromContext() returns clones distinct from req.event", async () => {
    let primaryId = "";
    let cloneId = "";
    h = await startApp((app, { recorder }) => {
      app.use(
        expressMiddleware({
          recorder,
          resolveActor: () => ({ type: "user", id: "u1" }),
        }),
      );
      app.post("/", (req, res) => {
        primaryId = req.event!.id;
        const sub = newFromContext();
        cloneId = sub.id;
        // Clone should inherit actor from template.
        expect(sub.actor).toEqual({ type: "user", id: "u1" });
        req.event!.action = "test";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    expect(primaryId).not.toBe(cloneId);
  });
});

describe("expressMiddleware: auto-record", () => {
  it("records once on response finish", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        req.event!.action = "user.login";
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.action).toBe("user.login");
    // Wait a tick for any duplicate close-fires.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.records).toHaveLength(1);
  });

  it("auto-fills result from response status when handler doesn't set one", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/forbidden", (req, res) => {
        req.event!.action = "user.lock";
        res.status(403).send();
      });
    });
    await fetch(`${h.url}/forbidden`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.code).toBe(403);
  });

  it("explicit result wins over auto-capture", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/reset", (req, res) => {
        req.event!.action = "password.reset_requested";
        req.event!.result = { status: "denied", message: "no account for email" };
        res.status(303).set("Location", "/check-email").send();
      });
    });
    await fetch(`${h.url}/reset`, { method: "POST", redirect: "manual" });
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.message).toBe("no account for email");
  });

  it("skips auto-record when action is empty", async () => {
    h = await startApp((app, { recorder }) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/noop", (_req, res) => {
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/noop`, { method: "POST" });
    // Give auto-record a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(h.records).toHaveLength(0);
  });

  it("does not auto-record when no recorder is configured", async () => {
    const calls: Event[] = [];
    const observer: Recorder = {
      async record(e) {
        calls.push(e);
      },
    };
    h = await startApp((app) => {
      // Middleware without a recorder still installs req.event.
      app.use(expressMiddleware({}));
      app.post("/", (req, res) => {
        // User would call observer.record manually here in practice.
        req.event!.action = "test";
        observer.record(req.event!);
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 30));
    // Manual record fired once; no double record from the middleware.
    expect(calls).toHaveLength(1);
  });

  // Invariant 3 regression: the middleware auto-records on finish/close, but
  // a handler may also record the same event explicitly through the same
  // recorder. Dedupe must be state (checked/set by both paths), not an
  // inference from "action is empty" - this handler sets action AND records
  // explicitly, so an inference-based dedupe would submit twice.
  //
  // The recorder here calls prepareEvent itself, exactly like the stock
  // HttpRecorder and BufferedRecorder do (recorder/http.ts, recorder/
  // buffered.ts) - that call is what lets the manual path claim the
  // dedupe flag before the auto-record backstop runs.
  it("does not double-record when a handler manually records req.event through the configured recorder (invariant 3)", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    h = await startApp((app) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        req.event!.action = "user.login";
        void recorder.record(req.event!); // manual path, same recorder as the middleware
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    // Wait for the finish/close auto-record backstop to have a chance to
    // (incorrectly) fire a second time.
    await new Promise((r) => setTimeout(r, 30));
    expect(records).toHaveLength(1);
  });

  // Invariant 4 regression, exercised through the real middleware: the
  // request-scoped event must carry idempotencyKey = id, and a
  // newFromContext() clone recorded from the same handler must stay
  // keyless, matching the core-level unit tests in event.test.ts.
  it("stamps idempotencyKey on req.event but not on newFromContext() clones", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    let cloneKey: string | undefined = "unset";
    h = await startApp((app) => {
      app.use(expressMiddleware({ recorder }));
      app.post("/", (req, res) => {
        req.event!.action = "user.login";
        const clone = newFromContext();
        clone.action = "user.login.clone";
        cloneKey = clone.idempotencyKey;
        void recorder.record(clone);
        res.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
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
      const app = express();
      app.use(expressMiddleware({ recorder: failingRec }));
      app.post("/", (req, res) => {
        req.event!.action = "test";
        res.status(200).send();
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", r));
      const port = (server.address() as AddressInfo).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
        expect(resp.status).toBe(200);
        // Wait for the catch handler to fire.
        await new Promise((r) => setTimeout(r, 30));
        expect(errSpy).toHaveBeenCalled();
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      }
    } finally {
      errSpy.mockRestore();
    }
  });
});
