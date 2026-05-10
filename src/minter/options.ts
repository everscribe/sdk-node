import { ALLOWED_COLUMNS } from "./columns.js";

/** Lower bound (ms) the server enforces on `expiresIn`. */
export const MIN_EXPIRES_IN_MS = 60 * 1000;
/** Upper bound (ms) the server enforces on `expiresIn`. */
export const MAX_EXPIRES_IN_MS = 24 * 60 * 60 * 1000;

/** Action filter grammar: ASCII alphanumeric and underscore, dot-separated
 *  segments, optional trailing `.*`. Mirrors the server's grammar. */
const ACTION_GRAMMAR = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*(\.\*)?$/;

/** Configures a token mint request. All fields are optional; an empty
 *  `TokenOptions` mints a 1-hour, full-project, read-only token. */
export interface TokenOptions {
  /** Scopes the token's reads to events with the matching tenant_id. The
   *  SDK trims the value before sending. Rejected if empty after trim or
   *  longer than 256 characters. */
  tenantId?: string;
  /** Token lifetime in milliseconds. The server clamps to
   *  [MIN_EXPIRES_IN_MS, MAX_EXPIRES_IN_MS]. Zero/undefined uses the
   *  server default (1 hour). */
  expiresIn?: number;
  /** Whitelist of Event JSON-tag field names. Omit (undefined) for no
   *  restriction; an explicit empty array is rejected so the SDK doesn't
   *  silently widen scope when callers build the list from filtered user
   *  input. */
  allowedColumns?: string[];
  /** Filter of allowed actions. Each entry is exact (`user.login`) or a
   *  suffix wildcard (`user.*`). Bare `*`, prefix wildcards (`*.create`),
   *  mid-string wildcards (`user.*.create`), and wildcards without a
   *  preceding dot (`user*`) are rejected. */
  allowedActions?: string[];
  /** Restricts which catalog fields the token's DSL queries (and
   *  NLP-generated DSL) can reference. Same nil / non-nil-empty
   *  semantics as allowedColumns / allowedActions — undefined for
   *  no restriction, empty array is rejected. */
  allowedFields?: string[];
  /** Unlocks the Query (advanced DSL) tab in the embed components
   *  and accepts `?q=` on the read API. Default false. */
  allowDSLInput?: boolean;
  /** Unlocks the AI ("Ask in plain English") tab in the embed
   *  components and POST /v1/embed/events/nlp. Default false.
  allowNLP?: boolean;
}

/** Validates `opts` and returns the wire-shape body. Throws a plain Error
 *  on validation failure — the throw short-circuits the round-trip so no
 *  HTTP call is made. */
export function tokenOptionsToWire(opts: TokenOptions): Record<string, unknown> {
  const wire: Record<string, unknown> = {};

  if (opts.tenantId !== undefined && opts.tenantId !== "") {
    const trimmed = opts.tenantId.trim();
    if (trimmed === "") throw new Error("minter: tenantId is empty after trim");
    if (trimmed.length > 256) throw new Error("minter: tenantId exceeds 256 chars");
    wire.tenant_id = trimmed;
  }

  if (opts.expiresIn !== undefined && opts.expiresIn !== 0) {
    if (opts.expiresIn < MIN_EXPIRES_IN_MS) {
      throw new Error(
        `minter: expiresIn ${opts.expiresIn}ms is below minimum ${MIN_EXPIRES_IN_MS}ms`,
      );
    }
    if (opts.expiresIn > MAX_EXPIRES_IN_MS) {
      throw new Error(
        `minter: expiresIn ${opts.expiresIn}ms is above maximum ${MAX_EXPIRES_IN_MS}ms`,
      );
    }
    wire.expires_in = Math.floor(opts.expiresIn / 1000);
  }

  if (opts.allowedColumns !== undefined) {
    if (opts.allowedColumns.length === 0) {
      throw new Error("minter: allowedColumns is empty; omit the field for no restriction");
    }
    for (const col of opts.allowedColumns) {
      if (!ALLOWED_COLUMNS.has(col)) {
        throw new Error(`minter: unknown column name "${col}"`);
      }
    }
    wire.columns = [...opts.allowedColumns];
  }

  if (opts.allowedActions !== undefined) {
    if (opts.allowedActions.length === 0) {
      throw new Error("minter: allowedActions is empty; omit the field for no restriction");
    }
    for (const a of opts.allowedActions) {
      if (!ACTION_GRAMMAR.test(a)) {
        throw new Error(
          `minter: action entry "${a}" does not match grammar [a-zA-Z0-9_]+(\\.[a-zA-Z0-9_]+)*(\\.\\*)?`,
        );
      }
    }
    wire.actions = [...opts.allowedActions];
  }

  if (opts.allowedFields !== undefined) {
    if (opts.allowedFields.length === 0) {
      throw new Error("minter: allowedFields is empty; omit the field for no restriction");
    }
    // Field validation lives on the server (the catalog is canonical
    // there); the SDK ships entries through verbatim.
    wire.allowed_fields = [...opts.allowedFields];
  }

  if (opts.allowDSLInput) wire.allow_dsl_input = true;
  if (opts.allowNLP) wire.allow_nlp = true;

  return wire;
}
