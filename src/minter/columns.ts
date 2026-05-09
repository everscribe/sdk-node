/** The set of valid Event field names accepted by the mint endpoint.
 *
 *  In the Go SDK these are derived via reflection over `event.Event`'s JSON
 *  struct tags. In TS we hard-code them — the wire shape is owned by this
 *  SDK (see `src/event/wire.ts`), so the list can't drift without an
 *  intentional change here. The minter's options validator and the server's
 *  allowlist must stay in sync; expanding `event.Event` requires updating
 *  this set too. */
export const ALLOWED_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "tenant_id",
  "occurred_at",
  "actor",
  "action",
  "target",
  "metadata",
  "origin",
  "result",
  "change",
  "idempotency_key",
]);
