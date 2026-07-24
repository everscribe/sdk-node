import type { Context, MiddlewareHandler } from "hono";

import { Event, begin, resultFromHttpStatus } from "./event/event.js";
import { originFromRequest } from "./event/origin.js";
import type { Actor, Logger, OutcomeCapture } from "./event/types.js";
import { consoleLogger } from "./recorder/logger.js";
import type { Recorder } from "./recorder/types.js";

export type ActorResolver = (c: Context) => Actor;

export interface HonoMiddlewareOptions {
  /** Recorder to send the per-request event to once the response has
   *  finalized. When omitted, the event lifecycle still runs (so
   *  `current()` works) but auto-record does not fire - handlers must call
   *  `recorder.record` themselves. */
  recorder?: Recorder;
  /** Derives the Actor for the request. Typically reads session data off
   *  `c`. Defaults to a resolver that returns `{ type: "anonymous" }`. */
  resolveActor?: ActorResolver;
  /** Logger for diagnostics (auto-record failures). Defaults to console. */
  logger?: Logger;
}

const ANONYMOUS: Actor = { type: "anonymous" };

/** Returns Hono middleware that:
 *
 *  1. Builds an Event template (Actor from `resolveActor`, Origin from
 *     request headers).
 *  2. Calls the core `begin` lifecycle, which installs an AsyncLocalStorage
 *     scope so `current()` and `newFromContext()` work for the duration of
 *     the request, and stamps an idempotency key on the request-scoped
 *     event.
 *  3. Installs an OutcomeCapture, backed by `resultFromHttpStatus`, so
 *     `prepareEvent` can auto-populate the event's Result from the final
 *     response status when the handler hasn't set one explicitly.
 *  4. Wraps `next()` so the request's context is installed for the
 *     downstream handler chain, and records once (in a `finally`, so a
 *     throwing handler still gets recorded) after `next()` settles -
 *     provided a recorder is configured and the handler set the event's
 *     `action`. Empty Action is a no-op. The core lifecycle dedupes this
 *     against a handler that already recorded the same event manually, so
 *     both paths never submit twice.
 *
 *  No adapter-specific accessor. Unlike Express (`req.event`) and Fastify
 *  (`request.event`), this adapter does not stash the event on `c`. Hono's
 *  Context is generic over an `Env` the caller supplies
 *  (`Context<{ Variables: ... }>`), and `c.set`/`c.get` are typed off that
 *  generic - adding an untyped `c.set("event", ...)` here would either
 *  require every consumer to thread an Everscribe-specific Variables type
 *  through their own `new Hono<Env>()` instantiation, or bypass Hono's
 *  typing entirely. Handlers instead reach the request-scoped event with
 *  the core's `current()`, exactly like sdk-go's gin/echo/fiber adapters,
 *  none of which stash a framework-specific accessor either.
 *
 *  The one thing this adapter has to get right: `c.finalized` is load
 *  bearing, the same way gin's `Writer.Written()` and echo's
 *  `Response().Committed` are in sdk-go. Hono pre-seeds `c.res` with a
 *  default 200 Response before the handler chain runs, so `c.res.status`
 *  reads 200 whether or not a handler ever produced a real response.
 *  `c.finalized` is Hono's own flag for "a handler actually produced a
 *  Response" (via `c.json`/`c.text`/`c.body`, or by returning a Response),
 *  and is what `OutcomeCapture.outcome` checks before trusting the status.
 *
 *  Unlike Fastify (see fastify.ts, which cannot tell "handler resolved
 *  without responding" from "handler sent an empty 200" because Fastify's
 *  own dispatcher auto-sends the resolved value either way), Hono does not
 *  paper over an unfinalized response. When the handler chain returns
 *  without ever finalizing, Hono's own dispatcher raises "Context is not
 *  finalized" and turns that into a 500 for the client - but that happens
 *  in Hono's outer dispatch, one layer above this middleware. By the time
 *  this middleware's `finally` block runs, `c.finalized` is still false, so
 *  `capture.outcome` correctly reports "no outcome yet" and `end()` records
 *  the core's "no response written" sentinel rather than a fabricated
 *  success - confirmed against a real Hono app in the adapter's test suite
 *  and in this repo's `.adapters-report.md`.
 *
 *  Origin's IP comes only from `X-Forwarded-For`/`X-Real-IP` headers, not a
 *  socket address: Hono's Context wraps a Web-standard Request, which
 *  (unlike Express's and Fastify's, both backed by Node's IncomingMessage)
 *  has no runtime-agnostic socket accessor - Hono runs on Node, Bun, Deno,
 *  and edge runtimes alike, each exposing connection info differently, if
 *  at all. `originFromRequest`'s `socket` field is optional for exactly
 *  this reason, so this falls back to an empty `ip` when neither forwarding
 *  header is present rather than depending on a Node-only escape hatch.
 *
 *  Mount this before route registration and after any auth middleware,
 *  since `resolveActor` typically reads request-scoped identity. */
export function honoMiddleware(opts: HonoMiddlewareOptions = {}): MiddlewareHandler {
  const resolve = opts.resolveActor ?? (() => ANONYMOUS);
  const rec = opts.recorder;
  const logger = opts.logger ?? consoleLogger;

  return async function eventMiddleware(c, next) {
    const template = new Event();
    template.actor = resolve(c);
    const origin = originFromRequest({ headers: c.req.header() });
    if (origin.ip || origin.userAgent || origin.requestId) {
      template.origin = origin;
    }

    const capture: OutcomeCapture = {
      get outcome() {
        if (!c.finalized) return undefined;
        return resultFromHttpStatus(c.res.status);
      },
    };

    const lifecycle = begin(template, capture, rec, logger);

    await lifecycle.run(async () => {
      try {
        await next();
      } finally {
        lifecycle.end();
      }
    });
  };
}
