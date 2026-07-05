/** Combines an optional caller-supplied AbortSignal with a per-request
 *  timeout. The returned signal aborts when either fires. Avoids the
 *  Node-20.3-only `AbortSignal.any` for compatibility with Node 20.0-20.2. */
export function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
  timeoutReason: unknown = new Error("request timeout"),
): AbortSignal {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(timeoutReason), timeoutMs);
  if (typeof timeoutId.unref === "function") timeoutId.unref();

  ctrl.signal.addEventListener("abort", () => clearTimeout(timeoutId), { once: true });

  if (caller) {
    if (caller.aborted) {
      ctrl.abort(caller.reason);
    } else {
      caller.addEventListener("abort", () => ctrl.abort(caller.reason), { once: true });
    }
  }
  return ctrl.signal;
}
