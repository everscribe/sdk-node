import { combineSignals } from "../internal/abort.js";

import { tokenOptionsToWire, type TokenOptions } from "./options.js";

const DEFAULT_BASE_URL = "https://api.everscribe.io";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface MinterOptions {
  /** Override the API host. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 10_000. */
  requestTimeout?: number;
}

export interface MintRequestOptions {
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
}

/** Returned by `Client.mintToken` when the mint endpoint responds with a
 *  non-2xx status (typically 400 invalid options, 401 bad auth, 404
 *  missing/soft-deleted project). */
export class MinterError extends Error {
  readonly statusCode: number;
  readonly body: string;

  constructor(statusCode: number, body: string) {
    super(`minter: http ${statusCode}: ${body}`);
    this.name = "MinterError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Mints embed tokens for a single project. Construct one and reuse for
 *  the lifetime of the process - Client is safe for concurrent use. */
export class Client {
  readonly baseUrl: string;
  readonly projectId: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeout: number;

  constructor(projectId: string, apiKey: string, opts: MinterOptions = {}) {
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeout = opts.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Requests a new embed token from the API and returns the JWT string
   *  on success. Validates options client-side before sending; validation
   *  errors short-circuit the round-trip. Server-side non-2xx responses
   *  surface as `MinterError`. */
  async mintToken(opts: TokenOptions = {}, reqOpts: MintRequestOptions = {}): Promise<string> {
    const wire = tokenOptionsToWire(opts);
    const body = JSON.stringify(wire);
    const url = `${this.baseUrl}/v1/projects/${this.projectId}/embed-tokens`;
    const signal = combineSignals(
      reqOpts.signal,
      this.requestTimeout,
      new Error("minter: request timeout"),
    );

    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });

    if (resp.status === 201) {
      let parsed: unknown;
      try {
        parsed = await resp.json();
      } catch (err) {
        throw new Error(
          `minter: decode response: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as { token?: unknown }).token !== "string"
      ) {
        throw new Error("minter: response missing token field");
      }
      return (parsed as { token: string }).token;
    }

    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    if (text.length > 4096) text = text.slice(0, 4096);
    throw new MinterError(resp.status, text.trim());
  }
}
