/** Identifies who caused the event. Type values are conventional, not enforced:
 *  "user", "admin", "system", "api_key", "anonymous". */
export interface Actor {
  type: string;
  id?: string;
  displayName?: string;
  email?: string;
}

/** What the event acted on. Both fields empty means "no target". */
export interface Target {
  type?: string;
  id?: string;
}

/** Network/request context where the event was emitted. */
export interface Origin {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/** Outcome of the audited action.
 *
 * `status`:  "ok" | "error" | "denied" - empty/undefined means unrecorded.
 * `code`:    HTTP status or app-defined code.
 * `message`: free-form. `Error` instances render as `err.message`; empty
 *            strings are omitted at the wire boundary. */
export interface Result {
  status?: string;
  code?: number;
  message?: unknown;
}

/** State transition for mutation events. `before`/`after` hold the (already
 *  redacted, if applicable) wire-shape state on either side; the audit-log
 *  API computes the JSON Patch on ingest. `patch` is optional and only set
 *  when the caller already has a precomputed RFC 6902 patch via `rawDiff`. */
export interface Change {
  before?: unknown;
  after?: unknown;
  patch?: unknown;
}

/** Reports the adapter-derived outcome for an in-flight call, so
 *  `prepareEvent` (and the core auto-record lifecycle) can auto-populate
 *  `Result` when the handler hasn't set one. Implemented by framework
 *  adapters (Express, Fastify, gRPC, etc.).
 *
 *  `outcome` is `undefined` when the call has not produced a result yet -
 *  this replaces an earlier design where a numeric HTTP status of 0 meant
 *  "nothing written." That sentinel does not generalize: gRPC's OK status
 *  is code 0, so a transport-neutral capture cannot signal "no outcome"
 *  with an integer. Adapters over an HTTP-shaped status build their
 *  `Result` via `resultFromHttpStatus`, which still special-cases 0 as
 *  "no response written." */
export interface OutcomeCapture {
  readonly outcome: Result | undefined;
}

/** Minimal logger interface used by buffered/HTTP recorders for diagnostics
 *  (overflow warnings, flush errors). Console-backed default lives in the
 *  recorder package. */
export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
