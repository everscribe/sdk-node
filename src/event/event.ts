import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Actor, Change, Origin, Result, StatusCapture, Target } from "./types.js";
import { applyRedaction, type DiffOption, type DiffOptions } from "./redact.js";

interface EventContext {
  template: Event;
  capture?: StatusCapture | undefined;
}

const eventStorage = new AsyncLocalStorage<EventContext>();

/** Canonical audit record. Construct via `new Event(action)` (non-HTTP) or
 *  `fromContext()` (after a middleware adapter has installed a template),
 *  populate the handler-specific fields (`action`, `target`, `metadata`,
 *  optionally `result`), and pass to `Recorder.record`. */
export class Event {
  id: string;
  occurredAt: Date;
  actor: Actor;
  action: string;
  tenantId?: string;
  target?: Target;
  metadata?: Record<string, unknown>;
  origin?: Origin;
  result?: Result;
  change?: Change;
  idempotencyKey?: string;

  constructor(action = "") {
    this.id = randomUUID();
    this.occurredAt = new Date();
    this.action = action;
    this.actor = { type: "" };
  }

  /** Sets a single metadata key/value. Allocates `metadata` on first use.
   *  Returns the receiver for chaining. */
  withField(key: string, value: unknown): this {
    if (!this.metadata) this.metadata = {};
    this.metadata[key] = value;
    return this;
  }

  /** Sets metadata from alternating key/value pairs, slog-style:
   *
   *      e.withFields("reason", "spam", "severity", "high")
   *
   *  Odd-length argument lists drop the trailing value. Non-string keys are
   *  silently skipped. Returns the receiver for chaining. */
  withFields(...args: unknown[]): this {
    if (args.length === 0) return this;
    if (!this.metadata) this.metadata = {};
    for (let i = 0; i + 1 < args.length; i += 2) {
      const key = args[i];
      if (typeof key !== "string") continue;
      this.metadata[key] = args[i + 1];
    }
    return this;
  }

  /** Records a state transition for a mutation event. `before` and `after`
   *  are JSON-normalized (matching Go's marshal+unmarshal round-trip) and
   *  any `withRedactedFields` paths are scrubbed before storage. The
   *  audit-log API computes the patch on ingest.
   *
   *  Marshal failures (e.g. circular references) leave `change` unset;
   *  the event still records. Returns the receiver for chaining. */
  diff(before: unknown, after: unknown, ...opts: DiffOption[]): this {
    const cfg: DiffOptions = {};
    for (const opt of opts) opt(cfg);
    const paths = cfg.redactPaths ?? [];
    const beforeOut = applyRedaction(before, paths);
    const afterOut = applyRedaction(after, paths);
    if (beforeOut === undefined || afterOut === undefined) return this;
    this.change = { before: beforeOut, after: afterOut };
    return this;
  }

  /** Escape hatch for callers that already have JSON-shaped before/after
   *  state, or who want to supply their own pre-computed RFC 6902 patch.
   *  Any of the three may be null/undefined; if all three are nullish, the
   *  call is a no-op. Returns the receiver for chaining. */
  rawDiff(before: unknown, after: unknown, patch: unknown): this {
    if (before == null && after == null && patch == null) return this;
    const change: Change = {};
    if (before !== undefined && before !== null) change.before = before;
    if (after !== undefined && after !== null) change.after = after;
    if (patch !== undefined && patch !== null) change.patch = patch;
    this.change = change;
    return this;
  }
}

/** Returns a fresh Event pre-populated from the request-scoped template
 *  installed by `runWithEvent` (typically called from a middleware adapter).
 *  Each call returns an independent Event — mutations don't leak across
 *  events derived from the same context.
 *
 *  When called outside a `runWithEvent` scope (e.g. from background jobs),
 *  returns a minimal `new Event()`. */
export function fromContext(): Event {
  const tmpl = eventStorage.getStore()?.template;
  if (!(tmpl instanceof Event)) return new Event();
  return cloneTemplate(tmpl);
}

/** Runs `fn` with `template` and `capture` installed in the AsyncLocalStorage
 *  scope. Adapter authors call this from inside their middleware to set up
 *  per-request state for `fromContext` and `prepareEvent`. */
export function runWithEvent<T>(
  template: Event,
  capture: StatusCapture | undefined,
  fn: () => T,
): T {
  const ctx: EventContext = capture !== undefined ? { template, capture } : { template };
  return eventStorage.run(ctx, fn);
}

/** Fills defaults on `e`: `id` if empty, `occurredAt` if missing, and
 *  `result` auto-populated from the in-scope `StatusCapture` when
 *  `result.status` is unset. Recorder implementations call this on each
 *  event before persisting so handlers can rely on auto-populated fields. */
export function prepareEvent(e: Event): void {
  if (!e.id) e.id = randomUUID();
  if (!e.occurredAt) e.occurredAt = new Date();
  if (!e.result?.status) {
    const capture = eventStorage.getStore()?.capture;
    if (capture) e.result = resultFromCapture(capture);
  }
}

function cloneTemplate(tmpl: Event): Event {
  const clone = new Event();
  clone.action = tmpl.action;
  clone.actor = { ...tmpl.actor };
  if (tmpl.tenantId) clone.tenantId = tmpl.tenantId;
  if (tmpl.target) clone.target = { ...tmpl.target };
  if (tmpl.origin) clone.origin = { ...tmpl.origin };
  if (tmpl.result) clone.result = { ...tmpl.result };
  // metadata explicitly NOT cloned — each event owns its own map.
  if (tmpl.change) clone.change = { ...tmpl.change };
  if (tmpl.idempotencyKey) clone.idempotencyKey = tmpl.idempotencyKey;
  return clone;
}

function resultFromCapture(capture: StatusCapture): Result {
  const status = capture.status;
  if (status === 0) {
    return { status: "error", message: "no response written" };
  }
  const r: Result = { code: status };
  if (status >= 200 && status < 400) r.status = "ok";
  else if (status === 401 || status === 403) r.status = "denied";
  else r.status = "error";
  return r;
}
