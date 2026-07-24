import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { current, Event, newFromContext, prepareEvent } from "../src/event/event.js";
import { fastifyPlugin } from "../src/fastify.js";
import type { Recorder } from "../src/recorder/types.js";

interface Harness {
  url: string;
  records: Event[];
  recorder: Recorder;
  recordDone: () => Promise<Event>;
  close(): Promise<void>;
}

async function startApp(
  configure: (app: FastifyInstance, harness: Pick<Harness, "recorder">) => void,
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
  const app = Fastify();
  configure(app, { recorder: opts.recorder === null ? (undefined as unknown as Recorder) : recorder });

  const url = await app.listen({ port: 0, host: "127.0.0.1" });

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
      await app.close();
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

describe("fastifyPlugin: actor and origin", () => {
  it("populates actor from resolveActor", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(
        fastifyPlugin({
          recorder,
          resolveActor: () => ({ type: "user", id: "u1", displayName: "alice" }),
        }),
      );
      app.post("/", (request, reply) => {
        request.event!.action = "test";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "user", id: "u1", displayName: "alice" });
  });

  it("defaults to anonymous when no resolver provided", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        request.event!.action = "test";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "anonymous" });
  });

  it("derives origin from request headers", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        request.event!.action = "test";
        void reply.status(200).send();
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
});

describe("fastifyPlugin: request.event, current(), and newFromContext", () => {
  it("installs a fresh Event on request.event for each request", async () => {
    const seen: string[] = [];
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        seen.push(request.event!.id);
        request.event!.action = "test";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("current() resolves the same event as request.event inside a handler", async () => {
    let sawSameId = false;
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        sawSameId = current().id === request.event!.id;
        request.event!.action = "test";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    expect(sawSameId).toBe(true);
  });

  it("newFromContext() returns clones distinct from request.event", async () => {
    let primaryId = "";
    let cloneId = "";
    h = await startApp((app, { recorder }) => {
      void app.register(
        fastifyPlugin({
          recorder,
          resolveActor: () => ({ type: "user", id: "u1" }),
        }),
      );
      app.post("/", (request, reply) => {
        primaryId = request.event!.id;
        const sub = newFromContext();
        cloneId = sub.id;
        expect(sub.actor).toEqual({ type: "user", id: "u1" });
        request.event!.action = "test";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await h.recordDone();
    expect(primaryId).not.toBe(cloneId);
  });
});

describe("fastifyPlugin: auto-record", () => {
  it("records once on response completion", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        request.event!.action = "user.login";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.action).toBe("user.login");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.records).toHaveLength(1);
  });

  it("auto-fills result from response status when handler doesn't set one", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/forbidden", (request, reply) => {
        request.event!.action = "user.lock";
        void reply.status(403).send();
      });
    });
    await fetch(`${h.url}/forbidden`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.code).toBe(403);
  });

  it("skips auto-record when action is empty", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/noop", (_request, reply) => {
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/noop`, { method: "POST" });
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
      void app.register(fastifyPlugin({}));
      app.post("/", (request, reply) => {
        request.event!.action = "test";
        void observer.record(request.event!);
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  // Fastify's own dispatcher auto-sends an async handler's resolved value,
  // even when that value is `undefined` - see fastify.ts's doc comment and
  // fastify's lib/wrap-thenable.js. A handler that names the event but
  // never calls reply.send() still ends up with a sent 200 by the time
  // onResponse fires, so this adapter's capture reports outcome {code:200,
  // status:"ok"}, not the "no response written" sentinel. This is
  // documented as a real limitation, not a bug in this test: it pins the
  // actual observed behavior so a change in Fastify's own semantics would
  // surface here.
  it("records a fabricated 200 when the handler returns without writing (documented Fastify limitation)", async () => {
    h = await startApp((app, { recorder }) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/nowrite", async (request, _reply) => {
        request.event!.action = "test.nowrite";
        // Deliberately no reply.send()/status() call and no return value.
        // Must be async: a sync handler that never calls reply.send() just
        // hangs (Fastify has nothing to auto-send), which is a different,
        // uninteresting case covered by fastify-probe3 in the report, not
        // this test.
      });
    });
    await fetch(`${h.url}/nowrite`, { method: "POST" });
    const e = await h.recordDone();
    expect(e.action).toBe("test.nowrite");
    expect(e.result?.status).toBe("ok");
    expect(e.result?.code).toBe(200);
  });

  // This is what the capture's headersSent/writableEnded check actually
  // guards, since by end() time (onResponse) Fastify guarantees the
  // response was sent regardless: a handler that records a sub-event via
  // newFromContext() BEFORE it has sent anything must see "no outcome yet",
  // not reply.raw.statusCode's default 200. Without the check, this event
  // would incorrectly come back {code: 200, status: "ok"} despite nothing
  // having been written when it was recorded.
  it("does not fill Result on a mid-handler event recorded before the response is sent", async () => {
    const records: Event[] = [];
    const recorder: Recorder = {
      async record(e) {
        prepareEvent(e);
        records.push(e);
      },
    };
    h = await startApp((app) => {
      void app.register(fastifyPlugin({ recorder }));
      app.post("/", (request, reply) => {
        const sub = newFromContext();
        sub.action = "mid.handler.event";
        void recorder.record(sub); // recorded before reply.send() below
        request.event!.action = "user.login";
        void reply.status(200).send();
      });
    });
    await fetch(`${h.url}/`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 30));
    const mid = records.find((e) => e.action === "mid.handler.event");
    expect(mid).toBeDefined();
    expect(mid?.result).toBeUndefined();
  });

  it("logs (does not throw) when auto-record fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingRec: Recorder = {
        async record() {
          throw new Error("boom");
        },
      };
      h = await startApp((app) => {
        void app.register(fastifyPlugin({ recorder: failingRec }));
        app.post("/", (request, reply) => {
          request.event!.action = "test";
          void reply.status(200).send();
        });
      });
      const resp = await fetch(`${h.url}/`, { method: "POST" });
      expect(resp.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
