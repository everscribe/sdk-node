import { Event, prepareEvent } from "../event/event.js";
import type { Logger } from "../event/types.js";

import { consoleLogger } from "./logger.js";
import {
  BufferFullError,
  DrainTimeoutError,
  isBatchRecorder,
  type BufferedRecorderOptions,
  type BufferedStats,
  type OverflowPolicy,
  type RecordOptions,
  type Recorder,
} from "./types.js";

interface ResolvedConfig {
  bufferSize: number;
  flushSize: number;
  flushInterval: number;
  flushTimeout: number;
  drainTimeout: number;
  overflowPolicy: OverflowPolicy;
  logger: Logger;
}

const DEFAULTS: ResolvedConfig = {
  bufferSize: 1000,
  flushSize: 100,
  flushInterval: 5_000,
  flushTimeout: 30_000,
  drainTimeout: 30_000,
  overflowPolicy: "drop-newest",
  logger: consoleLogger,
};

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal | undefined;
  abortListener?: (() => void) | undefined;
}

/** Wraps another Recorder to add asynchronous batched writes. Events are
 *  enqueued in an in-memory buffer and flushed to the inner recorder when
 *  either the size threshold (`flushSize`) or interval (`flushInterval`)
 *  fires, whichever comes first.
 *
 *  If the inner recorder implements `BatchRecorder`, flush uses
 *  `recordBatch` for efficiency; otherwise it loops `record` per event,
 *  recording the first error but not aborting the batch.
 *
 *  Call `close()` to stop the interval timer and drain pending events. */
export class BufferedRecorder implements Recorder {
  private readonly inner: Recorder;
  private readonly cfg: ResolvedConfig;
  private readonly queue: Event[] = [];
  private readonly waiters: Waiter[] = [];

  private droppedCount = 0;
  private flushedCount = 0;
  private flushErrCount = 0;
  private closed = false;
  private interval: NodeJS.Timeout | null = null;

  /** Serialization chain: every flush awaits the previous one's settlement
   *  so flushes never overlap. The chain swallows errors to keep the chain
   *  alive — individual flush errors are surfaced via `currentFlush`. */
  private flushChain: Promise<void> = Promise.resolve();
  /** Promise of the currently scheduled (or in-flight) flush, or null when
   *  no flush is pending. Resolves with the flush's outcome — errors from
   *  the inner recorder propagate here. */
  private currentFlush: Promise<void> | null = null;

  constructor(inner: Recorder, opts: BufferedRecorderOptions = {}) {
    this.inner = inner;
    this.cfg = {
      bufferSize: opts.bufferSize ?? DEFAULTS.bufferSize,
      flushSize: opts.flushSize ?? DEFAULTS.flushSize,
      flushInterval: opts.flushInterval ?? DEFAULTS.flushInterval,
      flushTimeout: opts.flushTimeout ?? DEFAULTS.flushTimeout,
      drainTimeout: opts.drainTimeout ?? DEFAULTS.drainTimeout,
      overflowPolicy: opts.overflowPolicy ?? DEFAULTS.overflowPolicy,
      logger: opts.logger ?? DEFAULTS.logger,
    };
    this.interval = setInterval(() => this.onTick(), this.cfg.flushInterval);
    if (typeof this.interval.unref === "function") this.interval.unref();
  }

  async record(e: Event, opts?: RecordOptions): Promise<void> {
    if (this.closed) return;
    if (!e || !e.action) return;
    prepareEvent(e);

    while (this.queue.length >= this.cfg.bufferSize) {
      if (this.closed) return;
      switch (this.cfg.overflowPolicy) {
        case "drop-newest":
          this.handleDrop(e);
          return;
        case "error":
          throw new BufferFullError();
        case "block":
          await this.waitForSpace(opts?.signal);
          break;
      }
    }
    if (this.closed) return;
    this.queue.push(e);
    if (this.queue.length >= this.cfg.flushSize) {
      this.scheduleFlush();
    }
  }

  /** Forces an immediate flush of all events buffered at the time of the
   *  call. Resolves once those events have been persisted, or rejects
   *  with the inner recorder's error. Calling `flush` after `close` is a
   *  no-op (resolves). */
  async flush(signal?: AbortSignal): Promise<void> {
    if (this.closed) return;
    signal?.throwIfAborted();

    const myFlush = this.scheduleFlush();
    if (!signal) {
      await myFlush;
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([myFlush, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /** Stops the interval timer, unblocks any waiters in PolicyBlock mode,
   *  and drains pending events. Throws DrainTimeoutError if `drainTimeout`
   *  elapses before drain completes. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.unblockAllWaiters();

    const drain = this.scheduleFlush().catch(() => {
      /* errors logged at flush time */
    });

    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.cfg.drainTimeout);
      if (typeof timeoutId.unref === "function") timeoutId.unref();
    });

    await Promise.race([drain, timeout]);
    if (timeoutId) clearTimeout(timeoutId);
    if (timedOut) throw new DrainTimeoutError();
  }

  stats(): BufferedStats {
    return {
      dropped: this.droppedCount,
      flushed: this.flushedCount,
      flushErrs: this.flushErrCount,
      pending: this.queue.length,
      bufferSize: this.cfg.bufferSize,
    };
  }

  private onTick(): void {
    if (this.closed) return;
    if (this.queue.length === 0) return;
    void this.scheduleFlush().catch(() => {
      /* errors logged at flush time */
    });
  }

  /** Schedules a flush if one isn't already pending. Returns a promise
   *  that resolves (or rejects) with the result of the next-running
   *  flush. Subsequent calls before that flush starts return the same
   *  promise so callers coalesce. */
  private scheduleFlush(): Promise<void> {
    if (this.currentFlush) return this.currentFlush;
    const promise = (async () => {
      await this.flushChain;
      this.currentFlush = null;
      if (this.queue.length === 0) return;
      const batch = this.queue.splice(0, this.queue.length);
      this.notifyBlockedWaiters();
      await this.runBatch(batch);
    })();
    this.currentFlush = promise;
    this.flushChain = promise.catch(() => {
      /* keep chain alive across errors */
    });
    return promise;
  }

  private async runBatch(batch: Event[]): Promise<void> {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(new Error("flush timeout")), this.cfg.flushTimeout);
    if (typeof timeoutId.unref === "function") timeoutId.unref();

    try {
      let firstErr: unknown;
      if (isBatchRecorder(this.inner)) {
        try {
          await this.inner.recordBatch(batch, { signal: ctrl.signal });
        } catch (err) {
          firstErr = err;
        }
      } else {
        for (const e of batch) {
          try {
            await this.inner.record(e, { signal: ctrl.signal });
          } catch (err) {
            if (firstErr === undefined) firstErr = err;
            // Continue — one failure should not abort the batch.
          }
        }
      }
      if (firstErr !== undefined) {
        this.flushErrCount++;
        this.cfg.logger.error("recorder flush failed", {
          error: firstErr instanceof Error ? firstErr.message : String(firstErr),
          batch_size: batch.length,
          flush_errs_total: this.flushErrCount,
        });
        throw firstErr;
      }
      this.flushedCount += batch.length;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private handleDrop(e: Event): void {
    this.droppedCount++;
    if (this.droppedCount === 1 || this.droppedCount % 1000 === 0) {
      this.cfg.logger.warn("recorder buffer full, event dropped", {
        action: e.action,
        dropped_total: this.droppedCount,
        buffer_size: this.cfg.bufferSize,
      });
    }
  }

  private waitForSpace(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) return resolve();
      if (signal?.aborted) {
        return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      }
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.abortListener = onAbort;
      }
      this.waiters.push(waiter);
    });
  }

  private notifyBlockedWaiters(): void {
    while (this.waiters.length > 0 && this.queue.length < this.cfg.bufferSize) {
      const w = this.waiters.shift()!;
      if (w.signal && w.abortListener) {
        w.signal.removeEventListener("abort", w.abortListener);
      }
      w.resolve();
    }
  }

  private unblockAllWaiters(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.signal && w.abortListener) {
        w.signal.removeEventListener("abort", w.abortListener);
      }
      w.resolve();
    }
  }
}
