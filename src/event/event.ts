import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Actor, Change, Logger, Origin, OutcomeCapture, Result, Target } from "./types.js";
import { applyRedaction, type DiffOption, type DiffOptions } from "./redact.js";

/** Minimal recording sink the core lifecycle needs. Redeclared here rather
 *  than imported from recorder/types.js, because recorder/http.ts and
 *  recorder/buffered.ts import this module and not the reverse - importing
 *  the real Recorder type here would create a cycle. Both concrete
 *  recorders satisfy this structurally. */
interface Recorder {
  record(e: Event): Promise<void>;
}

/** Per-request lifecycle state installed by `begin`. `recorded` dedupes the
 *  auto-record path (`end`) against a handler that also records the
 *  request-scoped event manually (`prepareEvent` marks it too). Node is
 *  single-threaded per request, so a plain boolean - checked and set by
 *  whichever path runs first - is correct; there is no need for the
 *  atomic-compare-and-swap dance a multi-threaded runtime would require. */
interface RequestState {
  current: Event;
  recorded: boolean;
}

interface EventContext {
  template: Event;
  capture: OutcomeCapture | undefined;
  /** Present only when installed via `begin`. `runWithEvent` callers get
   *  template/capture only - `current()` and the dedupe mark are no-ops
   *  outside a `begin` scope. */
  state?: RequestState;
}

const eventStorage = new AsyncLocalStorage<EventContext>();

/** Canonical audit record. Construct via `new Event(action)` (non-HTTP) or
 *  `newFromContext()` (after a middleware adapter has installed a template),
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

  /** Sets metadata from alternating key/value pairs:
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
   *  are JSON-normalized (via a marshal+unmarshal round-trip) and
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
 *  installed by `runWithEvent` or `begin` (typically called from a
 *  middleware adapter). Each call returns an independent Event - mutations
 *  don't leak across events derived from the same context, and the clone
 *  never inherits `idempotencyKey`: that key is stamped once, by `begin`,
 *  onto the single request-scoped event current() returns. A clone sharing
 *  it would let the server dedupe distinct events against each other.
 *
 *  When called outside a `runWithEvent`/`begin` scope (e.g. from background
 *  jobs), returns a minimal `new Event()`. */
export function newFromContext(): Event {
  const tmpl = eventStorage.getStore()?.template;
  if (!(tmpl instanceof Event)) return new Event();
  return cloneTemplate(tmpl);
}

/** Returns the request-scoped mutable event installed by `begin` - the
 *  event the adapter will auto-record. Framework-neutral: any adapter
 *  (Express, Fastify, gRPC, ...) exposes the same accessor instead of a
 *  transport-specific property like Express's `req.event`.
 *
 *  Handlers recording several events per request should call
 *  `newFromContext` instead, which returns a clone with a fresh ID. If no
 *  adapter installed a lifecycle on this context (no `begin` has run),
 *  returns a throwaway `new Event()` - harmless to call, but its return
 *  value is never recorded since nothing owns it. */
export function current(): Event {
  const state = eventStorage.getStore()?.state;
  return state ? state.current : new Event();
}

/** Runs `fn` with `template` and `capture` installed in the AsyncLocalStorage
 *  scope. Lower-level than `begin`: installs no request-scoped `current`
 *  event and no dedupe state, so `current()` returns a throwaway event and
 *  `prepareEvent`'s dedupe mark is a no-op inside this scope. Useful for
 *  exercising `newFromContext`/`prepareEvent`'s capture-fill behavior
 *  without the full auto-record lifecycle. Adapters driving a real
 *  request/response should use `begin` instead. */
export function runWithEvent<T>(
  template: Event,
  capture: OutcomeCapture | undefined,
  fn: () => T,
): T {
  const ctx: EventContext = { template, capture };
  return eventStorage.run(ctx, fn);
}

/** Handle returned by `begin`. Adapters call `run` to install this
 *  request's context around the handler, then `end` exactly once after the
 *  handler completes (typically from a response finish/close listener). */
export interface RequestLifecycle {
  /** The request-scoped mutable event - the same object `current()` returns
   *  while inside `run`. Already stamped with `idempotencyKey = id`. */
  readonly event: Event;
  /** Runs `fn` with this request's context installed. */
  run<T>(fn: () => T): T;
  /** Records the request-scoped event once, provided a recorder was
   *  configured and the handler named it (`action` is non-empty). Safe to
   *  call more than once, and safe to call after a handler has already
   *  recorded the same event manually - both paths share the `recorded`
   *  flag, so only the first submission wins.
   *
   *  Re-enters this request's AsyncLocalStorage context itself, since
   *  EventEmitter callbacks (e.g. `res.on("finish")`) do not inherit the
   *  context that was active when the listener was registered - only the
   *  context active at emit time, which by then is gone. Adapters can call
   *  `end` directly from such a callback without re-wrapping it. */
  end(): void;
}

/** Begins the audit lifecycle for one request: builds the request-scoped
 *  `current` event from `template`, installs it (with `capture`) in
 *  AsyncLocalStorage, and returns a handle adapters use to run the handler
 *  and, afterward, auto-record.
 *
 *  Stamps `idempotencyKey = id` on `current` unconditionally, and only on
 *  `current` - never on `template`. Both the manual path (a handler calling
 *  a recorder directly) and the auto-record path (`end`) must submit the
 *  same key so the server's conflict handling absorbs a duplicate instead
 *  of colliding on the events primary key; stamping later (e.g. in `end`)
 *  would key only the second submission, which doesn't dedupe at all.
 *  Stamping the template instead would be worse, since `newFromContext`
 *  clones it for every mid-handler event - every clone in a multi-event
 *  handler would then share one key and the server would silently discard
 *  all but the first. A handler that sets its own `idempotencyKey` simply
 *  overwrites this default, since it runs after `begin`. */
export function begin(
  template: Event,
  capture: OutcomeCapture | undefined,
  recorder: Recorder | undefined,
  logger: Logger | undefined,
): RequestLifecycle {
  const curr = cloneTemplate(template); // a clone, so the template stays unstamped
  curr.idempotencyKey = curr.id;
  const state: RequestState = { current: curr, recorded: false };
  const ctx: EventContext = { template, capture, state };

  return {
    event: curr,
    run<T>(fn: () => T): T {
      return eventStorage.run(ctx, fn);
    },
    end(): void {
      eventStorage.run(ctx, () => {
        if (!recorder || !curr.action) return;
        // Loser is a no-op. The manual path may already have won it via
        // prepareEvent.
        if (state.recorded) return;
        state.recorded = true;

        applyOutcome(capture, curr, true);
        recorder.record(curr).catch((err) => {
          logger?.error("everscribe: auto-record failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    },
  };
}

/** Fills defaults on `e`: `id` if empty, `occurredAt` if missing, and
 *  `result` auto-populated from the in-scope `OutcomeCapture` when
 *  `result.status` is unset. Recorder implementations call this on each
 *  event before persisting so handlers can rely on auto-populated fields.
 *
 *  Result population here is never final: `prepareEvent` can run
 *  mid-handler, when a handler records an extra event before the response
 *  is written. At that moment the capture legitimately reports no outcome
 *  yet - that does not mean no outcome ever - so unlike `end`, this leaves
 *  `result` untouched rather than stamping the "no response written"
 *  sentinel. Only `end` runs after the handler has genuinely finished and
 *  may apply that sentinel.
 *
 *  Also has a dedupe side effect, not obvious from the name: when `e` is
 *  the request-scoped event installed by `begin` (checked by identity, not
 *  by id), this marks it recorded so `end`'s auto-record backstop does not
 *  submit it a second time. */
export function prepareEvent(e: Event): void {
  if (!e.id) e.id = randomUUID();
  if (!e.occurredAt) e.occurredAt = new Date();

  const ctx = eventStorage.getStore();
  if (!ctx) return;
  applyOutcome(ctx.capture, e, false);
  if (ctx.state && e === ctx.state.current) ctx.state.recorded = true;
}

function cloneTemplate(tmpl: Event): Event {
  const clone = new Event();
  clone.action = tmpl.action;
  clone.actor = { ...tmpl.actor };
  if (tmpl.tenantId) clone.tenantId = tmpl.tenantId;
  if (tmpl.target) clone.target = { ...tmpl.target };
  if (tmpl.origin) clone.origin = { ...tmpl.origin };
  if (tmpl.result) clone.result = { ...tmpl.result };
  // metadata explicitly NOT cloned - each event owns its own map.
  if (tmpl.change) clone.change = { ...tmpl.change };
  // idempotencyKey explicitly NOT cloned. begin() stamps it once on the
  // single request-scoped current event; clones (from newFromContext) must
  // stay keyless; see newFromContext's doc comment for why.
  return clone;
}

/** Fills `Result` from `capture` when `e` doesn't already have one.
 *  `final` distinguishes `end` - which runs after the handler has genuinely
 *  completed and is guaranteed to be the last word on the event's outcome -
 *  from `prepareEvent`, which can run mid-handler. Only a final caller may
 *  stamp the "no response written" sentinel when the capture reports no
 *  outcome: from `prepareEvent`, no outcome yet just means "nothing written
 *  yet," not "nothing ever will be," and stamping the sentinel there would
 *  bake a false error into an event recorded before the response. */
function applyOutcome(capture: OutcomeCapture | undefined, e: Event, final: boolean): void {
  if (e.result?.status || !capture) return;
  const outcome = capture.outcome;
  if (outcome !== undefined) {
    e.result = outcome;
    return;
  }
  if (!final) return;
  // No outcome was produced, and this call is final: keeps the diagnostic
  // that used to live implicitly in this path, now explicit so no adapter
  // can silently drop it.
  e.result = { status: "error", message: "no response written" };
}

/** Derives a Result from an HTTP status code. Opt-in: core never calls this
 *  implicitly. Adapters over an HTTP-shaped status call it rather than each
 *  carrying a copy of the table.
 *
 *  code 0 means "no response written" and yields the same diagnostic the
 *  no-outcome path produces from `end`. */
export function resultFromHttpStatus(code: number): Result {
  if (code === 0) {
    return { status: "error", message: "no response written" };
  }
  const r: Result = { code };
  if (code >= 200 && code < 400) r.status = "ok";
  else if (code === 401 || code === 403) r.status = "denied";
  else r.status = "error";
  return r;
}
