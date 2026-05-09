import { describe, it, expect } from "vitest";

import { applyRedaction } from "../../src/event/redact.js";

describe("applyRedaction", () => {
  it("returns input unchanged when no paths", () => {
    expect(applyRedaction({ a: 1, b: 2 }, [])).toEqual({ a: 1, b: 2 });
  });

  it("redacts a top-level field", () => {
    expect(applyRedaction({ a: 1, b: 2 }, ["/a"])).toEqual({ a: "[REDACTED]", b: 2 });
  });

  it("redacts nested paths", () => {
    expect(applyRedaction({ a: { b: { c: "secret" } } }, ["/a/b/c"])).toEqual({
      a: { b: { c: "[REDACTED]" } },
    });
  });

  it("redacts array indices", () => {
    expect(applyRedaction({ items: ["a", "b", "c"] }, ["/items/1"])).toEqual({
      items: ["a", "[REDACTED]", "c"],
    });
  });

  it("supports JSON pointer escapes (~1 → /, ~0 → ~)", () => {
    expect(applyRedaction({ "a/b": "x", "c~d": "y" }, ["/a~1b", "/c~0d"])).toEqual({
      "a/b": "[REDACTED]",
      "c~d": "[REDACTED]",
    });
  });

  it("silently skips paths that don't exist", () => {
    expect(applyRedaction({ a: 1 }, ["/nope", "/also/missing"])).toEqual({ a: 1 });
  });

  it("silently skips out-of-bounds array indices", () => {
    expect(applyRedaction({ items: ["a"] }, ["/items/5", "/items/-1"])).toEqual({
      items: ["a"],
    });
  });

  it("silently skips non-numeric array indices", () => {
    expect(applyRedaction({ items: ["a"] }, ["/items/oops"])).toEqual({ items: ["a"] });
  });

  it("empty pointer redacts whole document", () => {
    expect(applyRedaction({ a: 1 }, [""])).toBe("[REDACTED]");
  });

  it("normalizes through JSON (Date → ISO string)", () => {
    const d = new Date("2024-01-01T00:00:00Z");
    expect(applyRedaction({ when: d }, [])).toEqual({ when: d.toISOString() });
  });

  it("does not mutate the caller's input", () => {
    const input = { secret: "x", other: 1 };
    applyRedaction(input, ["/secret"]);
    expect(input.secret).toBe("x");
  });

  it("returns undefined when value cannot be JSON-stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(applyRedaction(circular, [])).toBeUndefined();
  });

  it("ignores pointers without leading slash", () => {
    expect(applyRedaction({ a: 1 }, ["a"])).toEqual({ a: 1 });
  });
});
