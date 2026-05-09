import type { Event } from "../event/event.js";
import type { Logger } from "../event/types.js";

export interface RecordOptions {
  signal?: AbortSignal;
}

/** Records audit events. Implementations may be synchronous (HttpRecorder)
 *  or buffered (BufferedRecorder wraps another Recorder for async batching).
 *
 *  Implementations MUST treat an Event with an empty `action` as a no-op
 *  and resolve without recording. This enables the deferred-record idiom
 *  where handlers that bail out before setting `action` produce no event. */
export interface Recorder {
  record(e: Event, opts?: RecordOptions): Promise<void>;
}

/** Optional capability for inner recorders that can persist multiple events
 *  more efficiently than N serial Record calls. BufferedRecorder uses it
 *  when available and falls back to looped record() calls otherwise. */
export interface BatchRecorder {
  recordBatch(events: Event[], opts?: RecordOptions): Promise<void>;
}

/** Type guard for the optional BatchRecorder capability. */
export function isBatchRecorder(r: Recorder): r is Recorder & BatchRecorder {
  return typeof (r as Partial<BatchRecorder>).recordBatch === "function";
}

/** Behavior of `BufferedRecorder.record` when the buffer is full. */
export type OverflowPolicy = "drop-newest" | "block" | "error";

export interface BufferedStats {
  /** Total events dropped due to overflow. */
  dropped: number;
  /** Total events successfully flushed to the inner recorder. */
  flushed: number;
  /** Total flush calls that returned an error. */
  flushErrs: number;
  /** Events currently in the in-memory buffer. */
  pending: number;
  /** Configured buffer capacity. */
  bufferSize: number;
}

export interface HttpRecorderOptions {
  /** Override the ingestion endpoint. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 10_000. */
  requestTimeout?: number;
  /** Copy `event.id` into `event.idempotencyKey` at send time when the
   *  latter is empty. Caller-supplied keys win — auto-population only fills
   *  empty keys. Off by default. */
  autoIdempotencyKey?: boolean;
}

export interface BufferedRecorderOptions {
  /** Capacity of the in-memory event buffer. Default 1000. */
  bufferSize?: number;
  /** Pending-event count that triggers an immediate flush. Default 100. */
  flushSize?: number;
  /** Maximum time (ms) between flushes when the size threshold isn't
   *  reached. Default 5_000. */
  flushInterval?: number;
  /** Per-flush timeout (ms) applied to each call against the inner
   *  recorder. Default 30_000. */
  flushTimeout?: number;
  /** Behavior when `record` finds the buffer full. Default "drop-newest". */
  overflowPolicy?: OverflowPolicy;
  /** Maximum time (ms) `close` waits for in-flight events to flush before
   *  throwing DrainTimeoutError. Default 30_000. */
  drainTimeout?: number;
  /** Logger for SDK diagnostics (overflow warnings, flush errors). */
  logger?: Logger;
}

/** Combined options for the `recorder.create` factory. */
export type RecorderOptions = HttpRecorderOptions & BufferedRecorderOptions;

/** Returned by HttpRecorder when the ingestion endpoint responds with a
 *  non-2xx status. Inspect `transient` to distinguish retryable failures. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`recorder: http ${statusCode}: ${body}`);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.body = body;
  }

  /** True when the failure is likely to resolve on retry: 5xx server
   *  errors and 429 rate limits. */
  get transient(): boolean {
    return this.statusCode >= 500 || this.statusCode === 429;
  }
}

/** Thrown by `BufferedRecorder.record` when the overflow policy is "error"
 *  and the buffer has no space. */
export class BufferFullError extends Error {
  constructor() {
    super("recorder: buffer full");
    this.name = "BufferFullError";
  }
}

/** Thrown by `BufferedRecorder.close` when the drain timeout elapses with
 *  events still pending. */
export class DrainTimeoutError extends Error {
  constructor() {
    super("recorder: drain timeout exceeded");
    this.name = "DrainTimeoutError";
  }
}
