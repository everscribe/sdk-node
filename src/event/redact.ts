export interface DiffOptions {
  redactPaths?: string[];
}

export type DiffOption = (cfg: DiffOptions) => void;

/** Replaces values at the given JSON Pointer paths (RFC 6901) with
 *  "[REDACTED]" before they leave the process. Use on `Event.diff` for
 *  fields that must not appear in audit logs (password hashes, API keys,
 *  PII).
 *
 *      e.diff(before, after, withRedactedFields("/password_hash", "/api_keys/0"))
 *
 *  Paths that don't exist in the document are silently skipped. */
export function withRedactedFields(...paths: string[]): DiffOption {
  return (cfg) => {
    cfg.redactPaths = paths;
  };
}

/** Round-trips `value` through JSON to normalize types (Date → ISO string,
 *  etc.), then redacts the listed JSON Pointer paths in place. Mirrors Go's
 *  `marshalRedacted`: the result is a wire-shape value that the wire
 *  serializer can JSON.stringify directly. Returns `undefined` if `value`
 *  fails JSON.stringify. */
export function applyRedaction(value: unknown, paths: readonly string[]): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
  if (paths.length === 0) return doc;
  for (const p of paths) {
    doc = redactPath(doc, p);
  }
  return doc;
}

function redactPath(doc: unknown, pointer: string): unknown {
  if (pointer === "") return "[REDACTED]";
  if (!pointer.startsWith("/")) return doc;
  const tokens = splitPointer(pointer.slice(1));
  return redactTokens(doc, tokens);
}

function redactTokens(node: unknown, tokens: readonly string[]): unknown {
  if (tokens.length === 0) return "[REDACTED]";
  const head = tokens[0]!;
  const rest = tokens.slice(1);
  if (Array.isArray(node)) {
    const idx = parseUint(head);
    if (idx === undefined || idx < 0 || idx >= node.length) return node;
    node[idx] = redactTokens(node[idx], rest);
    return node;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (!(head in obj)) return obj;
    obj[head] = redactTokens(obj[head], rest);
    return obj;
  }
  return node;
}

function splitPointer(body: string): string[] {
  return body.split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parseUint(s: string): number | undefined {
  if (s.length === 0) return undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return undefined;
  }
  return Number(s);
}
