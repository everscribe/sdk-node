import { describe, expect, it } from "vitest";

import { ALLOWED_COLUMNS } from "../../src/minter/columns.js";
import {
  MAX_EXPIRES_IN_MS,
  MIN_EXPIRES_IN_MS,
  tokenOptionsToWire,
} from "../../src/minter/options.js";

describe("tokenOptionsToWire", () => {
  it("produces an empty object for default TokenOptions", () => {
    expect(tokenOptionsToWire({})).toEqual({});
  });

  it("trims tenantId before sending", () => {
    expect(tokenOptionsToWire({ tenantId: "  acme  " })).toEqual({ tenant_id: "acme" });
  });

  it("emits expires_in in seconds (matching the wire format)", () => {
    expect(tokenOptionsToWire({ expiresIn: 60 * 60 * 1000 })).toEqual({ expires_in: 3600 });
  });

  it("emits all four wire fields when set", () => {
    const wire = tokenOptionsToWire({
      tenantId: "acme",
      expiresIn: 60 * 60 * 1000,
      allowedColumns: ["occurred_at", "action"],
      allowedActions: ["user.login", "user.*"],
    });
    expect(wire).toEqual({
      tenant_id: "acme",
      expires_in: 3600,
      columns: ["occurred_at", "action"],
      actions: ["user.login", "user.*"],
    });
  });
});

describe("validation", () => {
  it.each([
    {
      name: "tenantId empty after trim",
      opts: { tenantId: "   " },
      message: "tenantId is empty after trim",
    },
    {
      name: "tenantId too long",
      opts: { tenantId: "a".repeat(257) },
      message: "tenantId exceeds 256 chars",
    },
    {
      name: "expiresIn below minimum",
      opts: { expiresIn: 30 * 1000 },
      message: "below minimum",
    },
    {
      name: "expiresIn above maximum",
      opts: { expiresIn: 25 * 60 * 60 * 1000 },
      message: "above maximum",
    },
    {
      name: "empty allowedColumns",
      opts: { allowedColumns: [] },
      message: "allowedColumns is empty",
    },
    {
      name: "unknown column name",
      opts: { allowedColumns: ["not_a_field"] },
      message: "unknown column name",
    },
    {
      name: "empty allowedActions",
      opts: { allowedActions: [] },
      message: "allowedActions is empty",
    },
    {
      name: "bare star action",
      opts: { allowedActions: ["*"] },
      message: "does not match grammar",
    },
    {
      name: "prefix wildcard action",
      opts: { allowedActions: ["*.create"] },
      message: "does not match grammar",
    },
    {
      name: "mid-string wildcard action",
      opts: { allowedActions: ["user.*.create"] },
      message: "does not match grammar",
    },
    {
      name: "wildcard without preceding dot",
      opts: { allowedActions: ["user*"] },
      message: "does not match grammar",
    },
    {
      name: "empty action entry",
      opts: { allowedActions: [""] },
      message: "does not match grammar",
    },
  ])("rejects $name", ({ opts, message }) => {
    expect(() => tokenOptionsToWire(opts)).toThrow(message);
  });
});

describe("accepted action forms", () => {
  it.each([
    ["exact single segment", ["login"]],
    ["exact multi segment", ["user.login"]],
    ["deep multi segment", ["billing.invoice.created"]],
    ["suffix wildcard", ["user.*"]],
    ["deep suffix wildcard", ["billing.invoice.*"]],
    ["mixed case", ["User.Login", "Billing.Invoice"]],
    ["underscores in segments", ["v1_create", "user.password_reset"]],
    ["mixed exact and wildcard", ["user.login", "user.*", "billing.*"]],
  ])("%s", (_name, actions) => {
    expect(() => tokenOptionsToWire({ allowedActions: actions })).not.toThrow();
  });
});

describe("ALLOWED_COLUMNS", () => {
  it("contains every Event JSON field name", () => {
    const expected = [
      "id",
      "tenant_id",
      "occurred_at",
      "actor",
      "action",
      "target",
      "metadata",
      "origin",
      "result",
      "change",
      "idempotency_key",
    ];
    expect(ALLOWED_COLUMNS.size).toBe(expected.length);
    for (const col of expected) {
      expect(ALLOWED_COLUMNS.has(col)).toBe(true);
    }
  });

  it("accepts a request that names every allowed column", () => {
    expect(() =>
      tokenOptionsToWire({ allowedColumns: [...ALLOWED_COLUMNS] }),
    ).not.toThrow();
  });
});

describe("expiresIn bounds", () => {
  it("MIN_EXPIRES_IN_MS is 60 seconds", () => {
    expect(MIN_EXPIRES_IN_MS).toBe(60_000);
  });

  it("MAX_EXPIRES_IN_MS is 24 hours", () => {
    expect(MAX_EXPIRES_IN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("accepts the exact boundary values", () => {
    expect(() => tokenOptionsToWire({ expiresIn: MIN_EXPIRES_IN_MS })).not.toThrow();
    expect(() => tokenOptionsToWire({ expiresIn: MAX_EXPIRES_IN_MS })).not.toThrow();
  });
});
