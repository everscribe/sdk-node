# @everscribe/sdk-node

Node/TypeScript SDK for the Everscribe audit-log API. Two coordinated surfaces:

- **Recorder** — append-only event ingest. Records who did what, when, on
  what resource, and — for mutation events — how the resource changed.
- **Minter** — mints short-lived embed tokens that let a customer's
  frontend mount the Everscribe embeddable component (e.g.
  `<EverscribeEvents />`) to display events without exposing the project
  API key to the browser.

Zero runtime dependencies. Requires Node 20+. Ships dual ESM + CJS builds
with TypeScript declarations.

---

## Table of contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Three key behaviors](#three-key-behaviors)
- [The Event shape](#the-event-shape)
- [BufferedRecorder](#bufferedrecorder)
- [Idempotency](#idempotency)
- [Embedded views](#embedded-views)

---

## Install

```sh
pnpm add @everscribe/sdk-node        # or: npm install / yarn add
```

```ts
import { create, createFromEnv, Event } from "@everscribe/sdk-node";
import * as event from "@everscribe/sdk-node/event";        // Event, fromContext, withRedactedFields, ...
import * as recorder from "@everscribe/sdk-node/recorder";  // BufferedRecorder, HttpRecorder, options
import * as minter from "@everscribe/sdk-node/minter";      // Client, TokenOptions
import { expressMiddleware } from "@everscribe/sdk-node/express";  // Express adapter
```

The root export is the entry point — bind credentials once and hand out
per-surface clients. Customers who only need one surface can call
`recorder.create` or `new minter.Client` directly to skip the SDK-client
step.

---

## Quickstart

### 1. Bind credentials and construct subclients

The root export binds the project ID and API key once and lets you build
per-surface clients without re-passing them:

```ts
import { create } from "@everscribe/sdk-node";

const es = create(projectId, apiKey);  // throws if either is empty/whitespace
const rec = es.newRecorder();
// shutdown: await rec.close();
```

For 12-factor / containerized deployments, read credentials from the
environment instead — `createFromEnv` reads `EVERSCRIBE_PROJECT_ID` and
`EVERSCRIBE_API_KEY` and throws naming the missing variable if either is
unset or empty:

```ts
import { createFromEnv } from "@everscribe/sdk-node";

const es = createFromEnv();
```

Override defaults by passing options to the subclient constructor:

```ts
const rec = es.newRecorder({
  bufferSize: 2000,
  flushInterval: 2_000,           // milliseconds
  overflowPolicy: "block",
});
```

Customers who only need the recorder can skip the root client:

```ts
import * as recorder from "@everscribe/sdk-node/recorder";

const rec = recorder.create(projectId, apiKey, { bufferSize: 2000 });
```

Both shapes are supported. The root client is the recommended path once
you wire up more than one surface (recorder + minter); the direct
factory is a one-line shortcut for ingest-only setups.

| Option                 | Description                                                                              | Default        |
|------------------------|------------------------------------------------------------------------------------------|----------------|
| `bufferSize`           | Capacity of the in-memory event buffer.                                                  | `1000`         |
| `flushSize`            | Pending-event count that triggers an immediate flush.                                    | `100`          |
| `flushInterval`        | Maximum time between flushes (ms) when the size threshold isn't reached.                 | `5000`         |
| `flushTimeout`         | Per-flush timeout (ms) applied to each call against the inner recorder.                  | `30_000`       |
| `overflowPolicy`       | Behavior when `record()` finds the buffer full. See [overflow policies](#overflow-policies). | `"drop-newest"` |
| `drainTimeout`         | Max time (ms) `close()` waits for in-flight events to flush before throwing.             | `30_000`       |
| `logger`               | `Logger` for SDK diagnostics (overflow warnings, flush errors).                          | console        |
| `baseUrl`              | Override the ingestion endpoint. Used for tests and staging environments.                | production URL |
| `fetch`                | Custom `fetch` implementation. Defaults to global `fetch`.                               | global         |
| `requestTimeout`       | Per-request timeout (ms) for HTTP calls.                                                 | `10_000`       |
| `autoIdempotencyKey`   | Copy `event.id` into `event.idempotencyKey` at send time when the latter is empty.       | off            |

### 2. Define your ActorResolver

```ts
import type { ActorResolver } from "@everscribe/sdk-node/express";
```

The resolver bridges session-provisioned request state to an `Actor`. In
Express you typically read from `req.session`, `req.user`, or whatever
your auth middleware attaches:

```ts
import type { Request, RequestHandler } from "express";

interface Session {
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

// Stand-in for your real session store (DB, Redis, signed cookie, etc.).
const sessions = new Map<string, Session>([
  ["sess_abc123", { userId: "u_42", username: "alice", email: "alice@example.com", isAdmin: false }],
  ["sess_def456", { userId: "u_99", username: "admin", email: "admin@example.com", isAdmin: true }],
]);

const sessionMw: RequestHandler = (req, _res, next) => {
  const cookie = req.headers.cookie?.match(/session_id=([^;]+)/)?.[1];
  if (cookie) req.session = sessions.get(cookie);
  next();
};
```

You'd then define an `ActorResolver` like:

```ts
const resolveActor: ActorResolver = (req) => {
  const s = req.session;
  if (!s) return { type: "anonymous" };
  return {
    type: s.isAdmin ? "admin" : "user",
    id: s.userId,
    displayName: s.username,
    email: s.email,
  };
};
```

### 3. Wire up the middleware

**Ordering matters.** The audit middleware must run **after** any
middleware that provisions the request with session data — the producer
(`sessionMw` above) has to run before the consumer (the audit middleware,
which calls your `resolveActor`):

```ts
import express from "express";
import { expressMiddleware } from "@everscribe/sdk-node/express";

const app = express();

// ✅ Session attaches identity first, then audit reads it.
app.use(sessionMw);
app.use(expressMiddleware({ recorder: rec, resolveActor }));
app.use(routes);

// ❌ Audit runs before session — resolveActor sees no session, every
//    event is provisioned with an anonymous Actor.
app.use(expressMiddleware({ recorder: rec, resolveActor }));
app.use(sessionMw);
app.use(routes);
```

### 4. Record events in handlers

The middleware installs `req.event` — a mutable Event for the current
request, pre-populated with Actor (from your resolver) and Origin (from
request headers). Enrich it during the handler; the middleware
auto-records on response finish if `action` is set.

```ts
app.post("/api-keys", async (req, res) => {
  req.event!.action = "api_key.create";

  try {
    const key = await createApiKey(req);
    req.event!.target = { type: "api_key", id: key.id };
    res.status(201).json(key);
    // happy path: result auto-captures as { status: "ok", code: 201 }
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : "error");
    // failure path: result auto-captures as { status: "error", code: 500 }
  }
});
```

`req.event` is typed `Event | undefined` because the middleware is
optional. Once you've mounted it on a route, the non-null assertion
(`req.event!`) is safe.

#### Recording state changes

For mutation events, attach the before/after state with `diff()`. The
audit-log API computes the JSON Patch on ingest.

```ts
import { withRedactedFields } from "@everscribe/sdk-node/event";

app.patch("/users/:id", async (req, res) => {
  const e = req.event!;
  e.action = "user.update";
  e.target = { type: "user", id: req.params.id };

  const before = await loadUser(req.params.id);
  if (!before) return res.status(404).send("not found");

  const after = await saveUser({ ...before, email: req.body.email });

  e.diff(before, after,
    // Redact sensitive fields from the diff
    withRedactedFields("/passwordHash"),
  );
  res.json(after);
});
```

`withRedactedFields` accepts [JSON Pointer](https://datatracker.ietf.org/doc/html/rfc6901)
paths (RFC 6901): leading `/`, slashes for nesting (`/billing/creditCard`),
integer segments for array indices (`/apiKeys/0`). Paths that don't exist
in the document are silently skipped.

#### Recording multiple events per request

Some handlers fan out — one privileged operation can affect many
resources, and each one is independently audit-worthy. A common
incident-response example is revoking every active session for a
compromised account: investigators need to see *which* sessions were
killed, not just that a bulk action ran. Call `fromContext()` once per
extra event so each gets a fresh clone of the per-request template
(Actor, Origin) without sharing or mutating metadata:

```ts
import { fromContext } from "@everscribe/sdk-node/event";

app.post("/users/:id/sessions/revoke-all", async (req, res) => {
  const sessions = await listActiveSessions(req.params.id);
  for (const s of sessions) {
    const e = fromContext();  // fresh clone per session
    e.action = "session.revoke";
    e.target = { type: "session", id: s.id };
    e.withFields("user_id", req.params.id, "reason", req.body.reason);

    try {
      await revokeSession(s.id);
    } catch (err) {
      e.result = { status: "error", message: err };
    }
    await rec.record(e);
  }
  res.status(204).send();
});
```

The buffered recorder coalesces these (and events from other concurrent
requests) into a single batch call to the ingestion API on each flush —
no need to assemble batches yourself.

---

## Three key behaviors

**Empty `action` is a no-op.** The middleware skips auto-record entirely
when `req.event.action` is empty, so handlers that bail out before
setting an action produce no event:

```ts
app.post("/users/:id/lock", async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user) return res.status(404).send("not found");
  // no action set — we don't care about audit logs for attempts to lock
  // a user that doesn't exist
  if (user.locked) return res.status(200).send();
  // ditto for already-locked

  req.event!.action = "user.lock";
  req.event!.target = { type: "user", id: user.id };
  await lockUser(user.id);
  res.status(200).send();
});
```

**Overriding the resolver's `actor`** — when there's no session yet
(login, signup) or when the actor isn't a session user (webhooks, system
tasks), the handler overrides `req.event.actor` directly. Login is the
canonical case: failed and successful attempts are both
security-relevant, but at handler entry the resolver returns
`anonymous` because the session doesn't exist until authentication
succeeds.

```ts
app.post("/login", async (req, res) => {
  const e = req.event!;

  const user = await authenticate(req);
  if (!user) {
    // Failed login: actor stays "anonymous" from the resolver. Capture
    // the attempted identifier for investigators.
    e.action = "user.login_failed";
    e.withFields("attempted_email", req.body.email);
    return res.status(401).send("invalid credentials");
  }

  // Successful login: override the resolver's "anonymous" with the user
  // we just authenticated.
  e.actor = {
    type: "user",
    id: user.id,
    displayName: user.username,
    email: user.email,
  };
  e.action = "user.login";

  issueSessionCookie(res, user);
  res.status(200).send();
});
```

**Explicit `result` wins over auto-capture** — when the HTTP status
doesn't reflect the operation's audit outcome. Password reset is the
canonical case: anti-enumeration security requires the API to redirect
to the same "check your email" page whether the email matched a real
account or not, so the user-facing response is identical. Audit
monitoring still needs to know which actually happened — repeated
"no match" entries are how you spot credential-stuffing campaigns:

```ts
app.post("/password/reset", async (req, res) => {
  const e = req.event!;
  const email = req.body.email;
  e.action = "password.reset_requested";
  e.withFields("attempted_email", email);

  const user = await lookupByEmail(email);
  if (!user) {
    // Explicit denied status overrides the auto-captured 303-redirect "ok".
    e.result = { status: "denied", message: "no account for email" };
    return res.redirect(303, "/password/check-your-email");
  }

  try {
    await sendResetEmail(user);
    e.target = { type: "user", id: user.id };
    res.redirect(303, "/password/check-your-email");
    // happy path: auto-captures as { status: "ok", code: 303 }
  } catch (err) {
    e.result = { status: "error", message: err };
    res.redirect(303, "/password/check-your-email");
  }
});
```

---

## The Event shape

```ts
interface Event {
  id: string;                              // uuid v4; auto-generated
  tenantId?: string;                       // optional within-project dimension
  occurredAt: Date;                        // auto-populated
  actor: Actor;                            // who caused the event
  action: string;                          // dotted verb, e.g. "user.lock"
  target?: Target;                         // what was acted on
  metadata?: Record<string, unknown>;      // freeform context
  origin?: Origin;                         // IP, user-agent, request ID
  result?: Result;                         // outcome: ok | error | denied
  change?: Change;                         // before/after state for mutations
  idempotencyKey?: string;                 // optional dedup key
}
```

The TS API uses **camelCase** field names; the wire format is
**snake_case** (`tenant_id`, `occurred_at`, `display_name`,
`idempotency_key`, etc.). The conversion happens at the recorder
boundary — JSON sent to the ingestion API is byte-compatible with the
Go SDK.

`projectId` is bound once at `create` and sent on every request as part
of the URL path.

`tenantId` groups events one level above the actor — set it when you
run a multi-tenant SaaS and want events queryable per workspace, org,
or connected account (multi-tenant CRMs, Stripe Connect-style
platforms, B2B tools). Single-tenant apps (B2C products, internal
dashboards) leave it blank.

`result.message` is `unknown` and special-cases `Error` — pass an
`Error` directly and it serializes as the result of `err.message`:

```ts
e.result = { status: "error", message: err };
```

Two helpers attach metadata in slog style:

```ts
e.withField("reason", "policy_violation");
e.withFields("reason", "spam", "severity", "high", "count", 3);
```

For non-HTTP callers, build events directly:

```ts
import { Event } from "@everscribe/sdk-node";

const e = new Event("subscription.trial_expired");
e.actor = { type: "system", id: "trial_expirer" };
e.target = { type: "subscription", id: subId };
await rec.record(e);
```

---

## BufferedRecorder

`recorder.create` (and `Client.newRecorder`) returns a `BufferedRecorder`
— events enqueue on an in-memory buffer and a flush is triggered when
the size threshold or interval is reached. Tuning knobs live in the
[Quickstart options table](#1-bind-credentials-and-construct-subclients);
the subsections below cover runtime concerns.

### Overflow policies

When the buffer is full at `record()` time:

| Policy           | Behavior                                                                          |
|------------------|-----------------------------------------------------------------------------------|
| `"drop-newest"`  | Drop the incoming event, increment counter, log warning. Default.                 |
| `"block"`        | Wait for space (resolves on free, abort signal, or close).                        |
| `"error"`        | Reject with `BufferFullError`.                                                    |

A full buffer means you're misconfigured — resize, speed up downstream,
or scale out. Watch `stats().dropped`.

### `flush()` and `stats()`

`flush(signal?)` synchronously drains everything buffered at the time of
the call. Useful for tests and graceful shutdown sync points. `close()`
calls a final drain — you don't need to `flush()` before `close()`.

`stats()` exposes counters for export to Prometheus/Datadog:

```ts
interface BufferedStats {
  dropped: number;     // total events dropped due to overflow
  flushed: number;     // total events successfully flushed to inner
  flushErrs: number;   // total flush calls that returned an error
  pending: number;     // events currently in the buffer
  bufferSize: number;  // buffer capacity
}
```

### Errors

The recorder package exports three error classes:

- `HttpError` — non-2xx response from the ingestion endpoint. Read
  `statusCode` and `body`; check `transient` (5xx + 429) to distinguish
  retryable failures.
- `BufferFullError` — overflow with `policy: "error"`.
- `DrainTimeoutError` — `close()` exceeded `drainTimeout` with events
  still pending.

---

## Idempotency

`event.idempotencyKey` is for caller-supplied stable keys — webhook
event IDs, upstream request IDs, anything that identifies "the same
logical event" across retries the SDK can't see:

```ts
e.idempotencyKey = stripeEvent.id;  // dedup if Stripe redelivers
```

For SDK-internal safety against double-sending the same Event object
(e.g., a manual `record()` plus an auto-record fired by the middleware),
enable `autoIdempotencyKey`. It copies `event.id` into `idempotencyKey`
at send time when the key is empty:

```ts
const rec = es.newRecorder({ autoIdempotencyKey: true });
```

Off by default. Caller-supplied keys always win — auto-population only
fills empty keys.

---

## Embedded views

The `@everscribe/sdk-node/minter` subpath mints short-lived JWT tokens that
let a customer's frontend mount the Everscribe embeddable component
(e.g. `<EverscribeEvents />`) without exposing the project API key to
the browser.

The flow has three actors:

1. **Customer's backend** (this SDK) holds the project API key and
   mints embed tokens via `Client.mintToken`.
2. **Customer's frontend** receives the token from a route the
   customer's backend exposes, and passes it as a prop to the React
   component. Never sees the API key.
3. **Everscribe API** verifies the token on each read and scopes
   results to the token's claims (tenant, columns, actions).

### Minting a token

The cleanest path is via the root client, which already holds the
credentials:

```ts
import { create } from "@everscribe/sdk-node";

const es = create(projectId, apiKey);
const rec = es.newRecorder();

const m = es.newMinter();

const token = await m.mintToken({
  tenantId: "acme-corp",
  expiresIn: 60 * 60 * 1000,           // milliseconds
  allowedColumns: ["occurred_at", "action", "actor"],
  allowedActions: ["user.*", "billing.invoice.created"],
});
// token is a JWT string; hand to the customer's frontend via your route.
```

Customers who only need the minter surface can construct it directly:

```ts
import * as minter from "@everscribe/sdk-node/minter";

const m = new minter.Client(projectId, apiKey);
const token = await m.mintToken({ /* ... */ });
```

### `TokenOptions`

| Field            | Type       | Behavior |
|------------------|------------|----------|
| `tenantId`       | `string`   | Optional. Scopes reads to events with the matching `tenant_id`. Trimmed by the SDK; rejected if empty after trim or > 256 chars. |
| `expiresIn`      | `number`   | Token lifetime in **milliseconds**. The server clamps to `[60s, 24h]`. Omit (or pass 0) to use the server default (1h). The SDK exports `MIN_EXPIRES_IN_MS` and `MAX_EXPIRES_IN_MS` for the bounds. |
| `allowedColumns` | `string[]` | Optional whitelist of `Event` JSON field names (snake_case). Omit for no restriction; an explicit empty array is rejected (avoids silently widening scope when callers build the list from filtered user input). The SDK exports `ALLOWED_COLUMNS` for the full set. |
| `allowedActions` | `string[]` | Optional filter of allowed actions. Each entry is exact (`user.login`) or a suffix wildcard (`user.*`). Omit for no restriction; empty array rejected. Bare `*`, prefix wildcards (`*.create`), mid-string wildcards (`user.*.create`), and wildcards without a preceding dot (`user*`) are rejected. |

### Errors

`mintToken` rejects with one of:

- A plain `Error` from client-side validation (caller-supplied options
  fail the SDK's checks; no HTTP call is made).
- `MinterError` for non-2xx responses from the mint endpoint —
  `statusCode` matches the spec: 400 for invalid options, 401 for bad
  auth, 404 for missing/soft-deleted project.
- A transport error (timeout, connection refused, network failure).

### Configuration

`new minter.Client` accepts options analogous to the recorder:

- `baseUrl` — override the API host (tests, staging).
- `fetch` — supply a custom `fetch` implementation.
- `requestTimeout` — per-request timeout in milliseconds.
