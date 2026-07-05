import { BufferedRecorder } from "./buffered.js";
import { HttpRecorder } from "./http.js";
import type { RecorderOptions } from "./types.js";

/** Recommended entry point. Returns a `BufferedRecorder` wrapping an
 *  `HttpRecorder` configured with the given credentials. Both HTTP and
 *  buffered options live on a single options object - the factory routes
 *  each to the appropriate inner constructor.
 *
 *      const rec = recorder.create(projectId, apiKey, {
 *        bufferSize: 500,
 *        flushInterval: 5_000,
 *        baseUrl: "https://staging.example.com",
 *      });
 *      try { ... } finally { await rec.close(); }
 *
 *  For custom inner recorders (dual-write, instrumented transport,
 *  synchronous-only writes), construct `HttpRecorder` and `BufferedRecorder`
 *  directly. */
export function create(projectId: string, apiKey: string, opts: RecorderOptions = {}): BufferedRecorder {
  const inner = new HttpRecorder(projectId, apiKey, {
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.requestTimeout !== undefined && { requestTimeout: opts.requestTimeout }),
    ...(opts.autoIdempotencyKey !== undefined && { autoIdempotencyKey: opts.autoIdempotencyKey }),
  });
  return new BufferedRecorder(inner, {
    ...(opts.bufferSize !== undefined && { bufferSize: opts.bufferSize }),
    ...(opts.flushSize !== undefined && { flushSize: opts.flushSize }),
    ...(opts.flushInterval !== undefined && { flushInterval: opts.flushInterval }),
    ...(opts.flushTimeout !== undefined && { flushTimeout: opts.flushTimeout }),
    ...(opts.drainTimeout !== undefined && { drainTimeout: opts.drainTimeout }),
    ...(opts.overflowPolicy !== undefined && { overflowPolicy: opts.overflowPolicy }),
    ...(opts.logger !== undefined && { logger: opts.logger }),
  });
}
