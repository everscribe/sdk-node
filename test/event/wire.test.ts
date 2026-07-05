import { describe, it, expect } from "vitest";

import { Event } from "../../src/event/event.js";
import { eventToWire, resultToWire } from "../../src/event/wire.js";

describe("resultToWire", () => {
  it("string message marshals as string", () => {
    expect(resultToWire({ status: "error", code: 500, message: "boom" })).toEqual({
      status: "error",
      code: 500,
      message: "boom",
    });
  });

  it("Error message marshals as .message", () => {
    expect(
      resultToWire({ status: "error", code: 500, message: new Error("db down") }),
    ).toEqual({ status: "error", code: 500, message: "db down" });
  });

  it("preserves an Error chain string", () => {
    const wrapped = new Error("recorder: wrapped: original");
    expect(resultToWire({ status: "error", message: wrapped })).toEqual({
      status: "error",
      message: "recorder: wrapped: original",
    });
  });

  it("undefined/null message is omitted", () => {
    expect(resultToWire({ status: "ok", code: 200 })).toEqual({ status: "ok", code: 200 });
    expect(resultToWire({ status: "ok", code: 200, message: null })).toEqual({
      status: "ok",
      code: 200,
    });
  });

  it("empty string message is omitted", () => {
    expect(resultToWire({ status: "ok", code: 200, message: "" })).toEqual({
      status: "ok",
      code: 200,
    });
  });

  it("non-string non-error message marshals via default JSON shape", () => {
    expect(resultToWire({ status: "ok", message: { k: 1 } })).toEqual({
      status: "ok",
      message: { k: 1 },
    });
  });

  it("returns undefined for an empty Result", () => {
    expect(resultToWire({})).toBeUndefined();
  });
});

describe("eventToWire", () => {
  it("converts camelCase TS fields to snake_case wire keys", () => {
    const e = new Event("user.update");
    e.tenantId = "t1";
    e.actor = { type: "user", id: "u1", displayName: "alice", email: "a@b" };
    e.target = { type: "user", id: "u1" };
    e.origin = { ip: "1.2.3.4", userAgent: "ua", requestId: "req-1" };
    e.idempotencyKey = "k1";

    const wire = eventToWire(e);
    expect(wire.tenant_id).toBe("t1");
    expect(wire.actor).toEqual({
      type: "user",
      id: "u1",
      display_name: "alice",
      email: "a@b",
    });
    expect(wire.target).toEqual({ type: "user", id: "u1" });
    expect(wire.origin).toEqual({
      ip: "1.2.3.4",
      user_agent: "ua",
      request_id: "req-1",
    });
    expect(wire.idempotency_key).toBe("k1");
    expect(wire.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits empty optional fields", () => {
    const e = new Event("user.login");
    e.actor = { type: "user", id: "u1" };
    const wire = eventToWire(e);
    expect(wire).toEqual({
      id: e.id,
      occurred_at: e.occurredAt.toISOString(),
      action: "user.login",
      actor: { type: "user", id: "u1" },
    });
  });

  it("always includes actor.type even when empty", () => {
    const e = new Event("x");
    const wire = eventToWire(e) as { actor: { type: string } };
    expect(wire.actor).toEqual({ type: "" });
  });

  it("renders an Error in result.message after JSON.stringify", () => {
    const e = new Event("user.login");
    e.actor = { type: "user" };
    e.result = { status: "error", code: 500, message: new Error("db down") };
    const json = JSON.stringify(eventToWire(e));
    const parsed = JSON.parse(json) as { result: { message: string } };
    expect(parsed.result.message).toBe("db down");
  });

  it("includes change with before/after", () => {
    const e = new Event("user.update").diff({ a: 1 }, { a: 2 });
    const wire = eventToWire(e) as { change: { before: unknown; after: unknown } };
    expect(wire.change.before).toEqual({ a: 1 });
    expect(wire.change.after).toEqual({ a: 2 });
  });

  it("omits metadata when empty", () => {
    const e = new Event("x");
    e.metadata = {};
    expect(eventToWire(e).metadata).toBeUndefined();
  });

  it("omits target when both fields empty", () => {
    const e = new Event("x");
    e.target = {};
    expect(eventToWire(e).target).toBeUndefined();
  });

  it("omits origin when all fields empty", () => {
    const e = new Event("x");
    e.origin = {};
    expect(eventToWire(e).origin).toBeUndefined();
  });

  it("omits result when all fields empty", () => {
    const e = new Event("x");
    e.result = {};
    expect(eventToWire(e).result).toBeUndefined();
  });
});
