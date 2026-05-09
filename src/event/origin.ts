import type { Origin } from "./types.js";

/** Minimal request shape compatible with Node's IncomingMessage and Express's
 *  Request. Adapters can also synthesize this shape from other frameworks. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined } | null | undefined;
}

/** Extracts network context from an HTTP request. Respects `X-Forwarded-For`
 *  (first entry) and `X-Real-IP` before falling back to socket.remoteAddress.
 *  Callers behind a proxy should sanitize untrusted client-supplied headers
 *  upstream. */
export function originFromRequest(req: RequestLike | null | undefined): Origin {
  if (!req) return {};
  const o: Origin = {};
  const ip = clientIp(req);
  if (ip) o.ip = ip;
  const ua = getHeader(req, "user-agent");
  if (ua) o.userAgent = ua;
  const rid = getHeader(req, "x-request-id");
  if (rid) o.requestId = rid;
  return o;
}

export function clientIp(req: RequestLike): string {
  const xff = getHeader(req, "x-forwarded-for");
  if (xff) {
    const comma = xff.indexOf(",");
    return (comma >= 0 ? xff.slice(0, comma) : xff).trim();
  }
  const xri = getHeader(req, "x-real-ip");
  if (xri) return xri;
  const addr = req.socket?.remoteAddress;
  if (!addr) return "";
  const lastColon = addr.lastIndexOf(":");
  return lastColon >= 0 ? addr.slice(0, lastColon) : addr;
}

function getHeader(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
