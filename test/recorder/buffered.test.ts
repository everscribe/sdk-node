import { describe, expect, it } from "vitest";

import { Event } from "../../src/event/event.js";
import { BufferedRecorder } from "../../src/recorder/buffered.js";
import {
  BufferFullError,
  type BatchRecorder,
  type Recorder,
} from "../../src/recorder/types.js";

import { silentLogger } from "./_server.js";

class CaptureRec implements Recorder {
  records: Event[] = [];
  err?: unknown;
  async record(e: Event): Promise<void> {
    this.records.push(e);
    if (this.err) throw this.err;
  }
}

class CaptureBatchRec implements Recorder, BatchRecorder {
  records: Event[] = [];
  batches: Event[][] = [];
  recordErr?: unknown;
  batchErr?: unknown;
  async record(e: Event): Promise<void> {
    this.records.push(e);
    if (this.recordErr) throw this.recordErr;
  }
  async recordBatch(events: Event[]): Promise<void> {
    this.batches.push([...events]);
    if (this.batchErr) throw this.batchErr;
  }
}

class BlockingRec implements Recorder {
  release: { promise: Promise<void>; resolve: () => void };
  calls = 0;
  constructor() {
    let resolveFn!: () => void;
    const promise = new Promise<void>((r) => {
      resolveFn = r;
    });
    this.release = { promise, resolve: resolveFn };
  }
  async record(): Promise<void> {
    this.calls++;
    await this.release.promise;
  }
}

/** Builds a BufferedRecorder with no auto-interval flush so tests are
 *  deterministic. */
function buildBuffered(
  inner: Recorder,
  opts: ConstructorParameters<typeof BufferedRecorder>[1] = {},
): BufferedRecorder {
  return new BufferedRecorder(inner, {
    flushInterval: 60 * 60 * 1000,
    logger: silentLogger,
    ...opts,
  });
}

async function pollUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("pollUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("BufferedRecorder.record", () => {
  it("populates id and occurredAt before queueing", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    const e = new Event();
    e.id = "";
    e.action = "user.login";
    await b.record(e);
    expect(e.id).toBeTruthy();
    expect(e.occurredAt).toBeInstanceOf(Date);
    await b.close();
  });

  it("empty-action events are no-ops", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    await b.record(new Event());
    await b.flush();
    expect(inner.records).toHaveLength(0);
    await b.close();
  });
});

describe("BufferedRecorder.flush", () => {
  it("drains pending events to the inner recorder", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    for (const a of ["a.one", "a.two", "a.three"]) {
      await b.record(new Event(a));
    }
    await b.flush();
    expect(inner.records.map((r) => r.action)).toEqual(["a.one", "a.two", "a.three"]);
    await b.close();
  });

  it("prefers BatchRecorder when the inner implements it", async () => {
    const inner = new CaptureBatchRec();
    const b = buildBuffered(inner);
    await b.record(new Event("a.one"));
    await b.record(new Event("a.two"));
    await b.flush();
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(2);
    expect(inner.records).toHaveLength(0);
    await b.close();
  });

  it("falls back to serial record() when inner is not a BatchRecorder", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    for (const a of ["a.one", "a.two", "a.three"]) {
      await b.record(new Event(a));
    }
    await b.flush();
    expect(inner.records).toHaveLength(3);
    await b.close();
  });

  it("propagates inner errors to the caller", async () => {
    const inner = new CaptureBatchRec();
    inner.batchErr = new Error("inner failed");
    const b = buildBuffered(inner);
    await b.record(new Event("a.one"));
    await expect(b.flush()).rejects.toThrow("inner failed");
    expect(b.stats().flushErrs).toBe(1);
    await b.close();
  });

  it("rejects with abort reason when signal is already aborted", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    await b.record(new Event("a.one"));
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    await expect(b.flush(ctrl.signal)).rejects.toThrow("cancelled");
    await b.close();
  });
});

describe("BufferedRecorder size-triggered flush", () => {
  it("flushes when queue length reaches flushSize", async () => {
    const inner = new CaptureBatchRec();
    const b = buildBuffered(inner, { flushSize: 3 });
    for (const a of ["a.one", "a.two", "a.three"]) {
      await b.record(new Event(a));
    }
    await pollUntil(() => inner.batches.length === 1);
    expect(inner.batches[0]).toHaveLength(3);
    await b.close();
  });
});

describe("BufferedRecorder interval flush", () => {
  it("flushes on interval", async () => {
    const inner = new CaptureBatchRec();
    const b = new BufferedRecorder(inner, {
      flushInterval: 20,
      logger: silentLogger,
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => inner.batches.length >= 1);
    await b.close();
  });
});

describe("BufferedRecorder.close", () => {
  it("drains pending events", async () => {
    const inner = new CaptureBatchRec();
    const b = new BufferedRecorder(inner, {
      flushInterval: 60 * 60 * 1000,
      logger: silentLogger,
    });
    await b.record(new Event("a.one"));
    await b.record(new Event("a.two"));
    await b.close();
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(2);
  });

  it("is idempotent", async () => {
    const b = buildBuffered(new CaptureRec());
    await b.close();
    await expect(b.close()).resolves.toBeUndefined();
  });
});

describe("BufferedRecorder post-close behavior", () => {
  it("record after close is silently dropped", async () => {
    const inner = new CaptureRec();
    const b = buildBuffered(inner);
    await b.close();
    await b.record(new Event("a.one"));
    expect(inner.records).toHaveLength(0);
  });

  it("flush after close is a no-op", async () => {
    const b = buildBuffered(new CaptureRec());
    await b.close();
    await expect(b.flush()).resolves.toBeUndefined();
  });
});

describe("BufferedRecorder overflow policies", () => {
  it("drop-newest counts dropped events without erroring", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, {
      bufferSize: 1,
      flushSize: 1,
      overflowPolicy: "drop-newest",
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));
    for (let i = 0; i < 5; i++) {
      await b.record(new Event("dropped"));
    }
    expect(b.stats().dropped).toBeGreaterThanOrEqual(1);
    blocker.release.resolve();
    await b.close().catch(() => {
      /* close may throw DrainTimeoutError if blocker hadn't released yet */
    });
  });

  it("error policy throws BufferFullError on overflow", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, {
      bufferSize: 1,
      flushSize: 1,
      overflowPolicy: "error",
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));
    await expect(b.record(new Event("a.three"))).rejects.toBeInstanceOf(BufferFullError);
    blocker.release.resolve();
    await b.close().catch(() => {
      /* may throw drain timeout */
    });
  });

  it("block policy waits for space and resolves once flush makes room", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, {
      bufferSize: 1,
      flushSize: 1,
      overflowPolicy: "block",
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));

    const blocked = b.record(new Event("a.three"));
    let settled = false;
    blocked.then(() => {
      settled = true;
    });
    // Releasing the blocker drains the in-flight inner.record, the chain
    // proceeds, and the blocked record can enqueue.
    blocker.release.resolve();
    await blocked;
    expect(settled).toBe(true);
    await b.close();
  });

  it("block policy rejects when signal aborts during the wait", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, {
      bufferSize: 1,
      flushSize: 1,
      overflowPolicy: "block",
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));

    const ctrl = new AbortController();
    const blocked = b.record(new Event("a.three"), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new Error("cancelled")), 20);
    await expect(blocked).rejects.toThrow("cancelled");
    blocker.release.resolve();
    await b.close().catch(() => {
      /* may throw drain timeout */
    });
  });

  it("block policy resolves (no error) when close fires during the wait", async () => {
    const blocker = new BlockingRec();
    const b = new BufferedRecorder(blocker, {
      bufferSize: 1,
      flushSize: 1,
      flushInterval: 60 * 60 * 1000,
      drainTimeout: 50,
      overflowPolicy: "block",
      logger: silentLogger,
    });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));

    const blocked = b.record(new Event("a.three"));
    // Tiny delay so the record() call enters waitForSpace before close fires.
    await new Promise((r) => setTimeout(r, 10));
    await b.close().catch(() => {
      /* expected DrainTimeoutError because blocker still holds inner */
    });
    await expect(blocked).resolves.toBeUndefined();
    blocker.release.resolve();
  });

  it("default policy is drop-newest", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, { bufferSize: 1, flushSize: 1 });
    await b.record(new Event("a.one"));
    await pollUntil(() => blocker.calls === 1);
    await b.record(new Event("a.two"));
    await expect(b.record(new Event("a.three"))).resolves.toBeUndefined();
    expect(b.stats().dropped).toBeGreaterThanOrEqual(1);
    blocker.release.resolve();
    await b.close().catch(() => {
      /* may throw drain timeout */
    });
  });
});

describe("BufferedRecorder.stats", () => {
  it("tracks flushed events", async () => {
    const inner = new CaptureBatchRec();
    const b = buildBuffered(inner);
    for (const a of ["a.one", "a.two", "a.three"]) {
      await b.record(new Event(a));
    }
    await b.flush();
    expect(b.stats().flushed).toBe(3);
    await b.close();
  });

  it("reports buffer size", async () => {
    const b = buildBuffered(new CaptureRec(), { bufferSize: 7 });
    expect(b.stats().bufferSize).toBe(7);
    await b.close();
  });

  it("reports pending events", async () => {
    const blocker = new BlockingRec();
    const b = buildBuffered(blocker, { bufferSize: 5, flushSize: 100 });
    await b.record(new Event("a.one"));
    await b.record(new Event("a.two"));
    expect(b.stats().pending).toBe(2);
    blocker.release.resolve();
    await b.close().catch(() => {
      /* may throw drain timeout */
    });
  });
});
