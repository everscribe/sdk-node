/** The set of valid Event field names accepted by the mint endpoint.
 *
 *  These field names are hard-coded here. The wire shape is owned by this
 *  SDK (see `src/event/wire.ts`), so the list can't drift without an
 *  intentional change here. The minter's options validator and the server's
 *  allowlist must stay in sync; expanding the event wire shape requires
 *  updating this set too. */
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
