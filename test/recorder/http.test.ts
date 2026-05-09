import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Event } from "../../src/event/event.js";
import { HttpRecorder } from "../../src/recorder/http.js";
import { HttpError } from "../../src/recorder/types.js";

import { startTestServer, type TestServer } from "./_server.js";

const PROJECT_ID = "proj_123";

let srv: TestServer;

beforeEach(async () => {
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
});

describe("HttpRecorder.record", () => {
  it("posts a single event with auth and content headers", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "secret-key", { baseUrl: srv.url });
    const e = new Event("user.login");
    e.actor = { type: "user", id: "u1" };
    await rec.record(e);

    expect(srv.requests).toHaveLength(1);
    const req = srv.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`/v1/projects/${PROJECT_ID}/events`);
    expect(req.headers.authorization).toBe("Bearer secret-key");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body) as { action: string; actor: { id: string } };
    expect(body.action).toBe("user.login");
    expect(body.actor.id).toBe("u1");
  });

  it("empty action is a no-op", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    await rec.record(new Event());
    expect(srv.requests).toHaveLength(0);
  });

  it("trims trailing slashes on baseUrl", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: `${srv.url}/` });
    await rec.record(new Event("t"));
    expect(srv.requests[0]!.path).toBe(`/v1/projects/${PROJECT_ID}/events`);
  });

  it("uses a default base URL when none is provided", () => {
    const rec = new HttpRecorder(PROJECT_ID, "k");
    expect(rec.baseUrl).toBe("https://api.everscribe.io");
  });
});

describe("HttpRecorder.recordBatch", () => {
  it("posts to the batch path with an events array", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    const e1 = new Event("user.login");
    e1.actor = { type: "user", id: "u1" };
    const e2 = new Event("user.logout");
    e2.actor = { type: "user", id: "u1" };
    await rec.recordBatch([e1, e2]);

    expect(srv.requests).toHaveLength(1);
    const req = srv.requests[0]!;
    expect(req.path).toBe(`/v1/projects/${PROJECT_ID}/events/batch`);
    const body = JSON.parse(req.body) as { events: Array<{ action: string }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.action).toBe("user.login");
    expect(body.events[1]!.action).toBe("user.logout");
  });

  it("filters out empty-action events", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    const e1 = new Event("user.login");
    const e2 = new Event(); // empty
    const e3 = new Event("user.logout");
    await rec.recordBatch([e1, e2, e3]);

    const body = JSON.parse(srv.requests[0]!.body) as { events: Array<{ action: string }> };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.action).toBe("user.login");
    expect(body.events[1]!.action).toBe("user.logout");
  });

  it("empty array is a no-op", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    await rec.recordBatch([]);
    expect(srv.requests).toHaveLength(0);
  });

  it("array of all empty-action events is a no-op", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    await rec.recordBatch([new Event(), new Event()]);
    expect(srv.requests).toHaveLength(0);
  });
});

describe("HttpRecorder error handling", () => {
  it.each([
    { status: 400, transient: false },
    { status: 401, transient: false },
    { status: 404, transient: false },
    { status: 429, transient: true },
    { status: 500, transient: true },
    { status: 502, transient: true },
    { status: 503, transient: true },
  ])("status $status throws HttpError with transient=$transient", async ({ status, transient }) => {
    srv.setResponse(status, "body text");
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });

    let caught: unknown;
    try {
      await rec.record(new Event("test"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.statusCode).toBe(status);
    expect(err.transient).toBe(transient);
    expect(err.body).toBe("body text");
  });

  it("rejects when the request times out", async () => {
    // A test server that never responds.
    const { createServer } = await import("node:http");
    const slow = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const port = (slow.address() as { port: number }).port;
    try {
      const rec = new HttpRecorder(PROJECT_ID, "k", {
        baseUrl: `http://127.0.0.1:${port}`,
        requestTimeout: 50,
      });
      await expect(rec.record(new Event("t"))).rejects.toThrow();
    } finally {
      slow.closeAllConnections?.();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

describe("HttpRecorder autoIdempotencyKey", () => {
  it("off by default leaves idempotency_key empty", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", { baseUrl: srv.url });
    await rec.record(new Event("user.login"));
    const body = JSON.parse(srv.requests[0]!.body) as { idempotency_key?: string };
    expect(body.idempotency_key).toBeUndefined();
  });

  it("enabled copies event id into idempotency_key", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", {
      baseUrl: srv.url,
      autoIdempotencyKey: true,
    });
    const e = new Event("user.login");
    await rec.record(e);
    const body = JSON.parse(srv.requests[0]!.body) as { id: string; idempotency_key: string };
    expect(body.idempotency_key).toBe(body.id);
    expect(body.idempotency_key).toBe(e.id);
  });

  it("caller-supplied idempotency key wins over auto-population", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", {
      baseUrl: srv.url,
      autoIdempotencyKey: true,
    });
    const e = new Event("user.login");
    e.idempotencyKey = "stripe_evt_42";
    await rec.record(e);
    const body = JSON.parse(srv.requests[0]!.body) as { idempotency_key: string };
    expect(body.idempotency_key).toBe("stripe_evt_42");
  });

  it("applies to batch entries individually", async () => {
    const rec = new HttpRecorder(PROJECT_ID, "k", {
      baseUrl: srv.url,
      autoIdempotencyKey: true,
    });
    const e1 = new Event("a.one");
    const e2 = new Event("a.two");
    e2.idempotencyKey = "explicit-2";
    await rec.recordBatch([e1, e2]);

    const body = JSON.parse(srv.requests[0]!.body) as {
      events: Array<{ id: string; idempotency_key: string }>;
    };
    expect(body.events[0]!.idempotency_key).toBe(body.events[0]!.id);
    expect(body.events[1]!.idempotency_key).toBe("explicit-2");
  });
});
