import { Client as MinterClient, type MinterOptions } from "./minter/client.js";
import type { BufferedRecorder } from "./recorder/buffered.js";
import { create as recorderCreate } from "./recorder/factory.js";
import type { RecorderOptions } from "./recorder/types.js";

const ENV_PROJECT_ID = "EVERSCRIBE_PROJECT_ID";
const ENV_API_KEY = "EVERSCRIBE_API_KEY";

/** Credential-bearing handle to an Everscribe project. Holds the project ID
 *  and API key so per-surface clients (recorder, minter) don't have to be
 *  re-passed them. Reuse a single Client for the lifetime of the process —
 *  it's safe for concurrent use. */
export class Client {
  readonly projectId: string;
  readonly #apiKey: string;

  /** Validates and trims credentials. Throws if either is empty or
   *  whitespace-only so configuration bugs surface at construction
   *  rather than at the first network call. */
  constructor(projectId: string, apiKey: string) {
    const trimmedId = projectId.trim();
    if (!trimmedId) throw new Error("everscribe: projectId is empty");
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) throw new Error("everscribe: apiKey is empty");
    this.projectId = trimmedId;
    this.#apiKey = trimmedKey;
  }

  /** Returns a buffered recorder for the bound project. Forwarded options
   *  apply to the recorder; see `RecorderOptions` for the full list
   *  (bufferSize, flushInterval, baseUrl, etc.). */
  newRecorder(opts: RecorderOptions = {}): BufferedRecorder {
    return recorderCreate(this.projectId, this.#apiKey, opts);
  }

  /** Returns a minter client for the bound project. Forwarded options
   *  apply to the minter; see `MinterOptions` for the full list
   *  (baseUrl, fetch, requestTimeout). */
  newMinter(opts: MinterOptions = {}): MinterClient {
    return new MinterClient(this.projectId, this.#apiKey, opts);
  }
}

/** Constructs a Client. Throws on empty/whitespace credentials. */
export function create(projectId: string, apiKey: string): Client {
  return new Client(projectId, apiKey);
}

/** Constructs a Client from environment variables. Reads
 *  `EVERSCRIBE_PROJECT_ID` and `EVERSCRIBE_API_KEY`. Throws (naming the
 *  missing variable) if either is unset or empty after trimming.
 *
 *  Use this in 12-factor / containerized deployments so credentials never
 *  appear in source. For tests and CLIs that pass credentials explicitly,
 *  call `create` directly. */
export function createFromEnv(): Client {
  const projectId = (process.env[ENV_PROJECT_ID] ?? "").trim();
  if (!projectId) throw new Error(`everscribe: ${ENV_PROJECT_ID} is not set or empty`);
  const apiKey = (process.env[ENV_API_KEY] ?? "").trim();
  if (!apiKey) throw new Error(`everscribe: ${ENV_API_KEY} is not set or empty`);
  return new Client(projectId, apiKey);
}
