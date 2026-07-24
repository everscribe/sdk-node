import { describe, it, expect } from "vitest";

import {
  Event,
  begin,
  current,
  newFromContext,
  prepareEvent,
  resultFromHttpStatus,
  runWithEvent,
} from "../../src/event/event.js";
import { withRedactedFields } from "../../src/event/redact.js";
import type { Logger, OutcomeCapture } from "../../src/event/types.js";

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

describe("newFromContext", () => {
  it("returns minimal event when no template in context", () => {
    const e = newFromContext();
    expect(e.id).toBeTruthy();
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.action).toBe("");
  });

  it("copies actor and origin from template", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user", id: "u1", displayName: "alice", email: "a@b" };
    tmpl.origin = { ip: "1.2.3.4", userAgent: "ua", requestId: "req1" };
    runWithEvent(tmpl, undefined, () => {
      const e = newFromContext();
      expect(e.actor).toEqual(tmpl.actor);
      expect(e.origin).toEqual(tmpl.origin);
      expect(e.id).toBeTruthy();
    });
  });

  it("returns independent clones (different IDs and metadata)", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user", id: "u1" };
    runWithEvent(tmpl, undefined, () => {
      const e1 = newFromContext();
      const e2 = newFromContext();
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
      const e = newFromContext();
      expect(e.metadata).toBeUndefined();
      e.withField("own", "value");
      expect(e.metadata?.shared).toBeUndefined();
      expect(e.metadata?.own).toBe("value");
    });
  });

  it("does not copy idempotencyKey off the template, even if the template has one set (invariant 6)", () => {
    // Defense in depth: begin() never stamps the template it stores, but
    // the clone helper must not propagate the key even if some future
    // caller hands newFromContext a template that already has one.
    const tmpl = new Event();
    tmpl.idempotencyKey = "should-not-propagate";
    runWithEvent(tmpl, undefined, () => {
      const clone = newFromContext();
      expect(clone.idempotencyKey).toBeFalsy();
    });
  });

  it("clones from a begin()-driven request stay keyless with fresh ids (invariant 4 + 6)", () => {
    const tmpl = new Event("tmpl.action");
    const lifecycle = begin(tmpl, undefined, undefined, undefined);
    lifecycle.run(() => {
      expect(lifecycle.event.idempotencyKey).toBeTruthy();
      expect(lifecycle.event.idempotencyKey).toBe(lifecycle.event.id);
      expect(tmpl.idempotencyKey).toBeFalsy();

      const clone = newFromContext();
      expect(clone.idempotencyKey).toBeFalsy();
      expect(clone.id).not.toBe(lifecycle.event.id);
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

  it("auto-fills result from outcome capture when result.status is empty", () => {
    const e = new Event("user.login");
    const capture: OutcomeCapture = { outcome: { status: "ok", code: 200 } };
    runWithEvent(e, capture, () => {
      prepareEvent(e);
    });
    expect(e.result?.status).toBe("ok");
    expect(e.result?.code).toBe(200);
  });

  it("does not overwrite explicit result", () => {
    const e = new Event("user.login");
    e.result = { status: "denied", code: 200, message: "manual" };
    runWithEvent(e, { outcome: { status: "ok", code: 200 } }, () => {
      prepareEvent(e);
    });
    expect(e.result.status).toBe("denied");
    expect(e.result.message).toBe("manual");
  });

  it("does nothing to result when no capture is in scope", () => {
    const e = new Event("x");
    prepareEvent(e);
    expect(e.result).toBeUndefined();
  });

  // Invariant 5: prepareEvent runs with final=false internally, so an
  // in-scope capture reporting no outcome yet must leave result untouched -
  // NOT stamp "no response written". That sentinel is end()'s alone to
  // apply, since only end() runs after the handler has genuinely finished.
  // A handler that records a mid-handler event (see newFromContext) before
  // the response is written must not get a false error baked into that
  // event just because nothing had been written YET.
  it("leaves result untouched when capture reports no outcome yet (invariant 5)", () => {
    const e = new Event("user.login.attempt");
    const capture: OutcomeCapture = { outcome: undefined };
    runWithEvent(e, capture, () => {
      prepareEvent(e);
    });
    expect(e.result).toBeUndefined();
  });
});

describe("current (invariant 2)", () => {
  it("returns a throwaway event outside any begin() scope", () => {
    const e = current();
    expect(e.id).toBeTruthy();
    expect(e.action).toBe("");
  });

  it("returns the same object begin() installed while inside run()", () => {
    const tmpl = new Event();
    const lifecycle = begin(tmpl, undefined, undefined, undefined);
    lifecycle.run(() => {
      expect(current()).toBe(lifecycle.event);
    });
  });

  it("is framework-neutral: works without any req/res object in scope", () => {
    const tmpl = new Event();
    tmpl.actor = { type: "user", id: "u1" };
    const lifecycle = begin(tmpl, undefined, undefined, undefined);
    lifecycle.run(() => {
      current().action = "user.login";
      expect(current().action).toBe("user.login");
      expect(current().actor).toEqual({ type: "user", id: "u1" });
    });
  });
});

describe("resultFromHttpStatus", () => {
  it.each([
    [200, "ok"],
    [201, "ok"],
    [303, "ok"],
    [401, "denied"],
    [403, "denied"],
    [404, "error"],
    [500, "error"],
  ])("status %i maps to %s", (status, expected) => {
    const r = resultFromHttpStatus(status);
    expect(r.status).toBe(expected);
    expect(r.code).toBe(status);
  });

  it("code 0 maps to error with no-response-written message", () => {
    const r = resultFromHttpStatus(0);
    expect(r.status).toBe("error");
    expect(r.message).toBe("no response written");
    expect(r.code).toBeUndefined();
  });
});

describe("begin/end lifecycle", () => {
  function stubRecorder(): { record: (e: Event) => Promise<void>; got: Event[] } {
    const got: Event[] = [];
    return {
      got,
      record: async (e: Event) => {
        got.push(e);
      },
    };
  }

  const nopLogger: Logger = { warn() {}, error() {} };

  it("skips recording an event the handler never named (empty action)", () => {
    const rec = stubRecorder();
    const lifecycle = begin(new Event(), { outcome: { status: "ok" } }, rec, nopLogger);
    lifecycle.end();
    expect(rec.got).toHaveLength(0);
  });

  it("records once and applies the outcome", async () => {
    const rec = stubRecorder();
    const capture: OutcomeCapture = { outcome: { status: "ok", code: 200 } };
    const lifecycle = begin(new Event(), capture, rec, nopLogger);
    lifecycle.run(() => {
      current().action = "user.login";
    });
    lifecycle.end();
    lifecycle.end(); // second call must be a no-op
    await Promise.resolve(); // let the record() microtask settle
    expect(rec.got).toHaveLength(1);
    expect(rec.got[0]?.result?.status).toBe("ok");
    expect(rec.got[0]?.result?.code).toBe(200);
  });

  it("applies the no-outcome sentinel only from end, never from a mid-handler prepareEvent (invariant 5)", async () => {
    const rec = stubRecorder();
    const capture: OutcomeCapture = { outcome: undefined };
    const lifecycle = begin(new Event(), capture, rec, nopLogger);
    let midEvent: Event | undefined;
    lifecycle.run(() => {
      current().action = "user.login";
      midEvent = newFromContext();
      midEvent.action = "user.login.attempt";
      prepareEvent(midEvent); // mid-handler manual record path
    });
    lifecycle.end(); // the response never got written: capture still reports no outcome

    expect(midEvent?.result).toBeUndefined();
    await Promise.resolve();
    expect(rec.got).toHaveLength(1);
    expect(rec.got[0]?.result?.status).toBe("error");
    expect(rec.got[0]?.result?.message).toBe("no response written");
  });

  // Invariant 3: dedupe is state (the recorded boolean), not inference from
  // an empty action. A handler that sets action AND records explicitly
  // must still result in exactly one submission.
  it("dedupes when a handler manually records the current event before end fires (invariant 3)", async () => {
    const rec = stubRecorder();
    const capture: OutcomeCapture = { outcome: { status: "ok", code: 200 } };
    const lifecycle = begin(new Event(), capture, rec, nopLogger);
    lifecycle.run(() => {
      current().action = "user.login";
      prepareEvent(current());
      void rec.record(current()); // the manual path
    });
    lifecycle.end(); // must be a no-op: the manual path already claimed it

    await Promise.resolve();
    expect(rec.got).toHaveLength(1);
  });

  it("preparing a clone does not suppress end's auto-record of the current event (invariant 3, negative case)", async () => {
    const rec = stubRecorder();
    const capture: OutcomeCapture = { outcome: { status: "ok", code: 200 } };
    const lifecycle = begin(new Event(), capture, rec, nopLogger);
    lifecycle.run(() => {
      current().action = "user.login";
      const clone = newFromContext();
      clone.action = "user.logout";
      prepareEvent(clone); // a different event: must not claim the current event's slot
    });
    lifecycle.end();

    await Promise.resolve();
    expect(rec.got).toHaveLength(1);
    expect(rec.got[0]?.action).toBe("user.login");
  });

  it("stamps idempotencyKey = id on the current event, never on the template (invariant 4)", () => {
    const tmpl = new Event();
    const lifecycle = begin(tmpl, undefined, undefined, undefined);
    expect(lifecycle.event.idempotencyKey).toBe(lifecycle.event.id);
    expect(tmpl.idempotencyKey).toBeFalsy();
  });

  it("logs, but does not throw, when the recorder rejects", async () => {
    const errors: unknown[] = [];
    const logger: Logger = { warn() {}, error: (msg, meta) => errors.push({ msg, meta }) };
    const failingRec = { record: async () => Promise.reject(new Error("boom")) };
    const lifecycle = begin(
      new Event(),
      { outcome: { status: "ok" } },
      failingRec,
      logger,
    );
    lifecycle.run(() => {
      current().action = "user.login";
    });
    expect(() => lifecycle.end()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
  });
});
