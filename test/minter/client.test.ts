import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client, MinterError } from "../../src/minter/client.js";

import { startTestServer, type TestServer } from "../recorder/_server.js";

const PROJECT_ID = "proj_123";

let srv: TestServer;

const successBody = JSON.stringify({
  token: "the.test.token",
  expires_at: "2026-05-02T13:30:00Z",
  expires_in: 3600,
});

beforeEach(async () => {
  srv = await startTestServer();
  srv.setResponse(201, successBody);
});

afterEach(async () => {
  await srv.close();
});

describe("Client.mintToken success path", () => {
  it("posts to the embed-tokens endpoint with auth and content headers", async () => {
    const c = new Client(PROJECT_ID, "secret-key", { baseUrl: srv.url });
    const token = await c.mintToken({
      tenantId: "acme",
      expiresIn: 60 * 60 * 1000,
      allowedColumns: ["occurred_at", "action"],
      allowedActions: ["user.login", "user.*"],
    });

    expect(token).toBe("the.test.token");
    expect(srv.requests).toHaveLength(1);
    const req = srv.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`/v1/projects/${PROJECT_ID}/embed-tokens`);
    expect(req.headers.authorization).toBe("Bearer secret-key");
    expect(req.headers["content-type"]).toBe("application/json");

    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toEqual({
      tenant_id: "acme",
      expires_in: 3600,
      columns: ["occurred_at", "action"],
      actions: ["user.login", "user.*"],
    });
  });

  it("an empty TokenOptions sends '{}'", async () => {
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url });
    await c.mintToken();
    expect(srv.requests[0]!.body).toBe("{}");
  });

  it("trims tenantId before sending", async () => {
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url });
    await c.mintToken({ tenantId: "  acme  " });
    const body = JSON.parse(srv.requests[0]!.body) as { tenant_id: string };
    expect(body.tenant_id).toBe("acme");
  });
});

describe("Client.mintToken error paths", () => {
  it.each([
    { status: 400, body: "invalid tenant_id" },
    { status: 401, body: "" },
    { status: 404, body: "project soft-deleted" },
  ])("status $status throws MinterError", async ({ status, body }) => {
    srv.setResponse(status, body);
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url });

    let caught: unknown;
    try {
      await c.mintToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MinterError);
    const err = caught as MinterError;
    expect(err.statusCode).toBe(status);
    expect(err.body).toBe(body);
  });

  it("client-side validation errors short-circuit the round-trip", async () => {
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url });
    await expect(c.mintToken({ tenantId: "   " })).rejects.toThrow("tenantId is empty after trim");
    expect(srv.requests).toHaveLength(0);
  });

  it("rejects when the caller's signal aborts before the request", async () => {
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url });
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    await expect(c.mintToken({}, { signal: ctrl.signal })).rejects.toThrow();
  });

  it("rejects on request timeout when the server stalls", async () => {
    const { createServer } = await import("node:http");
    const slow = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const port = (slow.address() as { port: number }).port;
    try {
      const c = new Client(PROJECT_ID, "k", {
        baseUrl: `http://127.0.0.1:${port}`,
        requestTimeout: 50,
      });
      await expect(c.mintToken()).rejects.toThrow();
    } finally {
      slow.closeAllConnections?.();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});

describe("Client construction", () => {
  it("uses the default base URL when none is provided", () => {
    const c = new Client(PROJECT_ID, "k");
    expect(c.baseUrl).toBe("https://api.everscribe.io");
  });

  it("trims trailing slashes from baseUrl", () => {
    const c = new Client(PROJECT_ID, "k", { baseUrl: "https://example.com/api/" });
    expect(c.baseUrl).toBe("https://example.com/api");
  });

  it("uses a custom fetch implementation when provided", async () => {
    let called = false;
    const customFetch: typeof fetch = async (input, init) => {
      called = true;
      return globalThis.fetch(input, init);
    };
    const c = new Client(PROJECT_ID, "k", { baseUrl: srv.url, fetch: customFetch });
    await c.mintToken();
    expect(called).toBe(true);
  });
});
