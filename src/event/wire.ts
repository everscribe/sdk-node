import type { Actor, Change, Origin, Result, Target } from "./types.js";
import type { Event } from "./event.js";

/** Serializes an Event to its wire shape: camelCase TS fields → snake_case
 *  JSON keys, with `omitempty`/`omitzero` semantics matching the Go SDK so
 *  the wire format is byte-compatible. Internal — used by the recorder
 *  package; exported across packages within this SDK. */
export function eventToWire(e: Event): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: e.id,
    occurred_at: e.occurredAt.toISOString(),
    action: e.action,
    actor: actorToWire(e.actor),
  };
  if (e.tenantId) wire.tenant_id = e.tenantId;
  const target = e.target ? targetToWire(e.target) : undefined;
  if (target) wire.target = target;
  if (e.metadata && Object.keys(e.metadata).length > 0) {
    wire.metadata = e.metadata;
  }
  const origin = e.origin ? originToWire(e.origin) : undefined;
  if (origin) wire.origin = origin;
  const result = e.result ? resultToWire(e.result) : undefined;
  if (result) wire.result = result;
  if (e.change) {
    const change = changeToWire(e.change);
    if (change) wire.change = change;
  }
  if (e.idempotencyKey) wire.idempotency_key = e.idempotencyKey;
  return wire;
}

function actorToWire(a: Actor): Record<string, unknown> {
  // `type` is always present (Go: no omitempty); other fields use omitempty.
  const w: Record<string, unknown> = { type: a.type };
  if (a.id) w.id = a.id;
  if (a.displayName) w.display_name = a.displayName;
  if (a.email) w.email = a.email;
  return w;
}

function targetToWire(t: Target): Record<string, unknown> | undefined {
  const w: Record<string, unknown> = {};
  if (t.type) w.type = t.type;
  if (t.id) w.id = t.id;
  return Object.keys(w).length > 0 ? w : undefined;
}

function originToWire(o: Origin): Record<string, unknown> | undefined {
  const w: Record<string, unknown> = {};
  if (o.ip) w.ip = o.ip;
  if (o.userAgent) w.user_agent = o.userAgent;
  if (o.requestId) w.request_id = o.requestId;
  return Object.keys(w).length > 0 ? w : undefined;
}

/** Mirrors Go's `Result.MarshalJSON`: Error → `.message`, empty string
 *  message omitted, all-empty Result returns undefined (omitted by caller). */
export function resultToWire(r: Result): Record<string, unknown> | undefined {
  const w: Record<string, unknown> = {};
  if (r.status) w.status = r.status;
  if (r.code) w.code = r.code;
  let message = r.message;
  if (message instanceof Error) message = message.message;
  if (typeof message === "string" && message === "") message = undefined;
  if (message !== undefined && message !== null) w.message = message;
  return Object.keys(w).length > 0 ? w : undefined;
}

function changeToWire(c: Change): Record<string, unknown> | undefined {
  const w: Record<string, unknown> = {};
  if (c.before !== undefined) w.before = c.before;
  if (c.after !== undefined) w.after = c.after;
  if (c.patch !== undefined) w.patch = c.patch;
  return Object.keys(w).length > 0 ? w : undefined;
}
