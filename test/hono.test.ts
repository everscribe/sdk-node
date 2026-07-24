import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { current, Event, newFromContext } from "../src/event/event.js";
import { honoMiddleware } from "../src/hono.js";
import type { Recorder } from "../src/recorder/types.js";

interface Harness {
  app: Hono;
  records: Event[];
  recorder: Recorder;
  recordDone: () => Promise<Event>;
}

function makeHarness(opts: { recorder?: Recorder | null } = {}): Harness {
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
  const app = new Hono();
  return {
    app,
    records,
    recorder: opts.recorder === null ? (undefined as unknown as Recorder) : recorder,
    recordDone: () =>
      new Promise<Event>((resolve) => {
        if (records.length > 0) resolve(records[records.length - 1]!);
        else resolveNext = resolve;
      }),
  };
}

describe("honoMiddleware: actor and origin", () => {
  it("populates actor from resolveActor", async () => {
    const h = makeHarness();
    h.app.use(
      honoMiddleware({
        recorder: h.recorder,
        resolveActor: () => ({ type: "user", id: "u1", displayName: "alice" }),
      }),
    );
    h.app.post("/", (c) => {
      current().action = "test";
      return c.body(null, 200);
    });
    await h.app.request("/", { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "user", id: "u1", displayName: "alice" });
  });

  it("defaults to anonymous when no resolver provided", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/", (c) => {
      current().action = "test";
      return c.body(null, 200);
    });
    await h.app.request("/", { method: "POST" });
    const e = await h.recordDone();
    expect(e.actor).toEqual({ type: "anonymous" });
  });

  it("derives origin from request headers (no socket - forwarding headers only)", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/", (c) => {
      current().action = "test";
      return c.body(null, 200);
    });
    await h.app.request("/", {
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

describe("honoMiddleware: current() and newFromContext", () => {
  it("current() resolves inside the handler with a fresh event per request", async () => {
    const seen: string[] = [];
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/", (c) => {
      seen.push(current().id);
      current().action = "test";
      return c.body(null, 200);
    });
    await h.app.request("/", { method: "POST" });
    await h.recordDone();
    await h.app.request("/", { method: "POST" });
    await h.recordDone();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe("");
  });

  it("newFromContext() returns clones distinct from current()", async () => {
    let primaryId = "";
    let cloneId = "";
    const h = makeHarness();
    h.app.use(
      honoMiddleware({
        recorder: h.recorder,
        resolveActor: () => ({ type: "user", id: "u1" }),
      }),
    );
    h.app.post("/", (c) => {
      primaryId = current().id;
      const sub = newFromContext();
      cloneId = sub.id;
      expect(sub.actor).toEqual({ type: "user", id: "u1" });
      current().action = "test";
      return c.body(null, 200);
    });
    await h.app.request("/", { method: "POST" });
    await h.recordDone();
    expect(primaryId).not.toBe(cloneId);
  });
});

describe("honoMiddleware: auto-record", () => {
  it("records once on a normal response", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/", (c) => {
      current().action = "user.login";
      return c.body(null, 200);
    });
    await h.app.request("/", { method: "POST" });
    const e = await h.recordDone();
    expect(e.action).toBe("user.login");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.records).toHaveLength(1);
  });

  it("auto-fills result from response status when handler doesn't set one", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/forbidden", (c) => {
      current().action = "user.lock";
      return c.body(null, 403);
    });
    await h.app.request("/forbidden", { method: "POST" });
    const e = await h.recordDone();
    expect(e.result?.status).toBe("denied");
    expect(e.result?.code).toBe(403);
  });

  it("skips auto-record when action is empty", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/noop", (c) => c.body(null, 200));
    await h.app.request("/noop", { method: "POST" });
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
    const app = new Hono();
    app.use(honoMiddleware({}));
    app.post("/", (c) => {
      current().action = "test";
      void observer.record(current());
      return c.body(null, 200);
    });
    await app.request("/", { method: "POST" });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
  });

  // The one behavior this suite exists to pin: unlike Fastify (which
  // fabricates a 200 for the same case - see fastify.test.ts), Hono does
  // NOT auto-send a response when the handler chain finishes without ever
  // finalizing one. c.finalized stays false, so this middleware's capture
  // reports "no outcome yet" and end() records the core's "no response
  // written" sentinel - the same behavior express/gin/echo record for a
  // handler that returns having written nothing.
  it("records the core's no-response-written sentinel when the handler returns without writing", async () => {
    const h = makeHarness();
    h.app.use(honoMiddleware({ recorder: h.recorder }));
    h.app.post("/nowrite", (c) => {
      current().action = "test.nowrite";
      // Deliberately returns without calling c.json/c.text/c.body and
      // without returning a Response.
      return undefined as unknown as Response;
    });
    // Hono's own dispatcher logs "Context is not finalized" to console.error
    // for this exact case before converting it to a 500 - expected noise
    // from Hono itself, not from this adapter, so it's silenced here.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let res: Response;
    try {
      res = await h.app.request("/nowrite", { method: "POST" });
    } finally {
      errSpy.mockRestore();
    }
    // Hono's own dispatcher turns the unfinalized context into a 500 for
    // the client - that is Hono's behavior, not this adapter's.
    expect(res.status).toBe(500);
    const e = await h.recordDone();
    expect(e.action).toBe("test.nowrite");
    expect(e.result?.status).toBe("error");
    expect(e.result?.message).toBe("no response written");
  });

  it("logs (does not throw) when auto-record fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingRec: Recorder = {
        async record() {
          throw new Error("boom");
        },
      };
      const app = new Hono();
      app.use(honoMiddleware({ recorder: failingRec }));
      app.post("/", (c) => {
        current().action = "test";
        return c.body(null, 200);
      });
      const res = await app.request("/", { method: "POST" });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
