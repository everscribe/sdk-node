import { Event, prepareEvent } from "../event/event.js";
import { eventToWire } from "../event/wire.js";
import { combineSignals } from "../internal/abort.js";

import {
  HttpError,
  type BatchRecorder,
  type HttpRecorderOptions,
  type RecordOptions,
  type Recorder,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.everscribe.io";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Posts events to the audit-log ingestion API.
 *
 *  Wire format:
 *
 *      POST {baseUrl}/v1/projects/{projectId}/events         body: Event
 *      POST {baseUrl}/v1/projects/{projectId}/events/batch   body: { events: [...] }
 *      Authorization: Bearer {apiKey}
 *      Content-Type:  application/json
 *
 *  Non-2xx responses become `HttpError`. Inspect `transient` to
 *  distinguish retryable (5xx, 429) from permanent (4xx) failures. */
export class HttpRecorder implements Recorder, BatchRecorder {
  readonly baseUrl: string;
  readonly projectId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeout: number;
  private readonly autoIdempotencyKey: boolean;

  constructor(projectId: string, apiKey: string, opts: HttpRecorderOptions = {}) {
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeout = opts.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.autoIdempotencyKey = opts.autoIdempotencyKey ?? false;
  }

  async record(e: Event, opts?: RecordOptions): Promise<void> {
    if (!e || !e.action) return;
    prepareEvent(e);
    this.finalize(e);
    const body = JSON.stringify(eventToWire(e));
    await this.post(`/v1/projects/${this.projectId}/events`, body, opts?.signal);
  }

  async recordBatch(events: Event[], opts?: RecordOptions): Promise<void> {
    if (!events || events.length === 0) return;
    const wire: unknown[] = [];
    for (const e of events) {
      if (!e.action) continue;
      prepareEvent(e);
      this.finalize(e);
      wire.push(eventToWire(e));
    }
    if (wire.length === 0) return;
    const body = JSON.stringify({ events: wire });
    await this.post(`/v1/projects/${this.projectId}/events/batch`, body, opts?.signal);
  }

  private finalize(e: Event): void {
    if (this.autoIdempotencyKey && !e.idempotencyKey) {
      e.idempotencyKey = e.id;
    }
  }

  private async post(path: string, body: string, callerSignal?: AbortSignal): Promise<void> {
    const signal = combineSignals(callerSignal, this.requestTimeout, new Error("recorder: request timeout"));
    const resp = await this.fetchImpl(this.baseUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });

    if (resp.ok) {
      // Drain so the connection can be reused.
      try {
        await resp.body?.cancel();
      } catch {
        /* ignore */
      }
      return;
    }

    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    if (text.length > 4096) text = text.slice(0, 4096);
    throw new HttpError(resp.status, text.trim());
  }
}

