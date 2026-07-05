import { describe, it, expect } from "vitest";

import { Event, fromContext, prepareEvent, runWithEvent } from "../../src/event/event.js";
import { withRedactedFields } from "../../src/event/redact.js";
import type { StatusCapture } from "../../src/event/types.js";

describe("new Event", () => {
  it("populates defaults", () => {
    const e = new Event("user.login");
    expect(e.id).toBeTruthy();
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.action).toBe("user.login");
  });

  it("default constructor leaves action empty", () => {
    const e = new Event();
    expect(e.action).toBe("");
    expect(e.id).toBeTruthy();
  });
});

describe("fromContext", () => {
  it("returns minimal event when no template in context", () => {
    const e = fromContext();
    expect(e.id).toBeTruthy();
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.action).toBe("");
  });

  it("copies actor and origin from template", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user", id: "u1", displayName: "alice", email: "a@b" };
    tmpl.origin = { ip: "1.2.3.4", userAgent: "ua", requestId: "req1" };
    runWithEvent(tmpl, undefined, () => {
      const e = fromContext();
      expect(e.actor).toEqual(tmpl.actor);
      expect(e.origin).toEqual(tmpl.origin);
      expect(e.id).toBeTruthy();
    });
  });

  it("returns independent clones (different IDs and metadata)", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user", id: "u1" };
    runWithEvent(tmpl, undefined, () => {
      const e1 = fromContext();
      const e2 = fromContext();
      expect(e1.id).not.toBe(e2.id);
      e1.withField("k", "v1");
      e2.withField("k", "v2");
      expect(e1.metadata?.k).toBe("v1");
      expect(e2.metadata?.k).toBe("v2");
      expect(tmpl.metadata).toBeUndefined();
    });
  });

  it("isolates metadata from template", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user" };
    tmpl.metadata = { shared: "yes" };
    runWithEvent(tmpl, undefined, () => {
      const e = fromContext();
      expect(e.metadata).toBeUndefined();
      e.withField("own", "value");
      expect(e.metadata?.shared).toBeUndefined();
      expect(e.metadata?.own).toBe("value");
    });
  });
});

describe("withField", () => {
  it("allocates metadata on first use", () => {
    const e = new Event();
    expect(e.metadata).toBeUndefined();
    e.withField("k", "v");
    expect(e.metadata?.k).toBe("v");
  });

  it("is chainable", () => {
    const e = new Event().withField("a", 1).withField("b", 2);
    expect(e.metadata?.a).toBe(1);
    expect(e.metadata?.b).toBe(2);
  });
});

describe("withFields", () => {
  it("handles alternating key/value pairs", () => {
    const e = new Event().withFields("reason", "spam", "severity", "high", "count", 3);
    expect(e.metadata).toEqual({ reason: "spam", severity: "high", count: 3 });
  });

  it("drops trailing value on odd-length args", () => {
    const e = new Event().withFields("reason", "spam", "orphan");
    expect(e.metadata).toEqual({ reason: "spam" });
  });

  it("skips non-string keys", () => {
    const e = new Event().withFields("ok", 1, 42, "bad", "also_ok", 2);
    expect(e.metadata).toEqual({ ok: 1, also_ok: 2 });
  });

  it("leaves metadata undefined on empty args", () => {
    const e = new Event().withFields();
    expect(e.metadata).toBeUndefined();
  });
});

describe("Event.diff", () => {
  it("stores before and after as wire-shape values", () => {
    const before = { id: "u1", email: "old@example.com" };
    const after = { id: "u1", email: "new@example.com" };
    const e = new Event("user.update").diff(before, after);
    expect(e.change?.before).toEqual(before);
    expect(e.change?.after).toEqual(after);
    expect(e.change?.patch).toBeUndefined();
  });

  it("redacts listed paths in before and after", () => {
    const before = { id: "u1", password_hash: "old", api_key: "k_old", email: "a@b" };
    const after = { id: "u1", password_hash: "new", api_key: "k_new", email: "a@b" };
    const e = new Event("user.update").diff(
      before,
      after,
      withRedactedFields("/password_hash", "/api_key"),
    );
    const b = e.change?.before as Record<string, unknown>;
    const a = e.change?.after as Record<string, unknown>;
    expect(b.password_hash).toBe("[REDACTED]");
    expect(b.api_key).toBe("[REDACTED]");
    expect(b.email).toBe("a@b");
    expect(a.password_hash).toBe("[REDACTED]");
    expect(a.api_key).toBe("[REDACTED]");
  });

  it("silently skips paths that don't exist", () => {
    const e = new Event("x").diff(
      { id: "u1" },
      { id: "u1" },
      withRedactedFields("/nonexistent", "/also/missing"),
    );
    expect(e.change?.before).toEqual({ id: "u1" });
    expect(e.change?.after).toEqual({ id: "u1" });
  });

  it("returns receiver for chaining", () => {
    const e = new Event("user.update");
    expect(e.diff({}, {})).toBe(e);
  });

  it("does not mutate the caller's input", () => {
    const before = { secret: "x", other: 1 };
    new Event("x").diff(before, before, withRedactedFields("/secret"));
    expect(before.secret).toBe("x");
  });
});

describe("Event.rawDiff", () => {
  it("populates all three fields", () => {
    const e = new Event("x").rawDiff({ v: 1 }, { v: 2 }, [
      { op: "replace", path: "/v", value: 2 },
    ]);
    expect(e.change?.before).toEqual({ v: 1 });
    expect(e.change?.after).toEqual({ v: 2 });
    expect(e.change?.patch).toEqual([{ op: "replace", path: "/v", value: 2 }]);
  });

  it("all-null is a no-op", () => {
    const e = new Event("x").rawDiff(null, null, null);
    expect(e.change).toBeUndefined();
  });

  it("all-undefined is a no-op", () => {
    const e = new Event("x").rawDiff(undefined, undefined, undefined);
    expect(e.change).toBeUndefined();
  });

  it("patch only is sufficient", () => {
    const e = new Event("x").rawDiff(undefined, undefined, []);
    expect(e.change).toBeDefined();
    expect(e.change?.patch).toEqual([]);
    expect(e.change?.before).toBeUndefined();
    expect(e.change?.after).toBeUndefined();
  });
});

describe("prepareEvent", () => {
  it("fills id and occurredAt when missing", () => {
    const e = new Event();
    e.id = "";
    (e as { occurredAt: Date | undefined }).occurredAt = undefined as unknown as Date;
    prepareEvent(e);
    expect(e.id).toBeTruthy();
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  it("auto-fills result from status capture when result.status is empty", () => {
    const e = new Event("user.login");
    const capture: StatusCapture = { status: 200 };
    runWithEvent(e, capture, () => {
      prepareEvent(e);
    });
    expect(e.result?.status).toBe("ok");
    expect(e.result?.code).toBe(200);
  });

  it("does not overwrite explicit result", () => {
    const e = new Event("user.login");
    e.result = { status: "denied", code: 200, message: "manual" };
    runWithEvent(e, { status: 200 }, () => {
      prepareEvent(e);
    });
    expect(e.result.status).toBe("denied");
    expect(e.result.message).toBe("manual");
  });

  it.each([
    [200, "ok"],
    [201, "ok"],
    [303, "ok"],
    [401, "denied"],
    [403, "denied"],
    [404, "error"],
    [500, "error"],
  ])("status %i maps to %s", (status, expected) => {
    const e = new Event("x");
    runWithEvent(e, { status }, () => prepareEvent(e));
    expect(e.result?.status).toBe(expected);
    expect(e.result?.code).toBe(status);
  });

  it("status 0 (no response) maps to error with no-response-written message", () => {
    const e = new Event("x");
    runWithEvent(e, { status: 0 }, () => prepareEvent(e));
    expect(e.result?.status).toBe("error");
    expect(e.result?.message).toBe("no response written");
  });

  it("does nothing to result when no capture is in scope", () => {
    const e = new Event("x");
    prepareEvent(e);
    expect(e.result).toBeUndefined();
  });
});
