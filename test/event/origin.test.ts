import { describe, it, expect } from "vitest";

import { clientIp, originFromRequest, type RequestLike } from "../../src/event/origin.js";

function makeReq(opts: {
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
}): RequestLike {
  return {
    headers: Object.fromEntries(
      Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    socket: opts.remoteAddress !== undefined ? { remoteAddress: opts.remoteAddress } : undefined,
  };
}

describe("clientIp", () => {
  it("uses first entry from X-Forwarded-For", () => {
    const req = makeReq({ headers: { "X-Forwarded-For": "1.2.3.4, 10.0.0.1, 10.0.0.2" } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("uses X-Real-IP when no X-Forwarded-For", () => {
    const req = makeReq({ headers: { "X-Real-IP": "5.6.7.8" } });
    expect(clientIp(req)).toBe("5.6.7.8");
  });

  it("prefers X-Forwarded-For over X-Real-IP", () => {
    const req = makeReq({
      headers: { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "5.6.7.8" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to remoteAddress, stripping a trailing port", () => {
    const req = makeReq({ remoteAddress: "9.10.11.12:54321" });
    expect(clientIp(req)).toBe("9.10.11.12");
  });

  it("returns remoteAddress unchanged when there's no port", () => {
    const req = makeReq({ remoteAddress: "9.10.11.12" });
    expect(clientIp(req)).toBe("9.10.11.12");
  });

  it("returns empty string when nothing is available", () => {
    expect(clientIp(makeReq({}))).toBe("");
  });

  it("flattens an array-valued X-Forwarded-For to its first entry", () => {
    const req = makeReq({ headers: { "X-Forwarded-For": ["1.2.3.4", "fallback"] } });
    expect(clientIp(req)).toBe("1.2.3.4");
  });
});

describe("originFromRequest", () => {
  it("returns empty origin for null/undefined request", () => {
    expect(originFromRequest(null)).toEqual({});
    expect(originFromRequest(undefined)).toEqual({});
  });

  it("populates ip, userAgent, requestId from headers", () => {
    const req = makeReq({
      headers: {
        "X-Forwarded-For": "1.2.3.4",
        "User-Agent": "test-ua/1.0",
        "X-Request-ID": "req-abc",
      },
    });
    const o = originFromRequest(req);
    expect(o.ip).toBe("1.2.3.4");
    expect(o.userAgent).toBe("test-ua/1.0");
    expect(o.requestId).toBe("req-abc");
  });

  it("omits empty fields", () => {
    expect(originFromRequest(makeReq({}))).toEqual({});
  });
});
