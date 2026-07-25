import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { Event, begin, resultFromHttpStatus, type RequestLifecycle } from "./event/event.js";
import { originFromRequest, type RequestLike } from "./event/origin.js";
import type { Actor, Logger, OutcomeCapture } from "./event/types.js";
import { consoleLogger } from "./recorder/logger.js";
import type { Recorder } from "./recorder/types.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Mutable event installed by `fastifyMiddleware`. Auto-recorded on
     *  `onResponse` when a recorder was configured. */
    event?: Event;
  }
}

export type ActorResolver = (req: FastifyRequest) => Actor;

export interface FastifyMiddlewareOptions {
  /** Recorder to send the per-request event to once the response has been
   *  sent. When omitted, `request.event` is still installed but auto-record
   *  does not fire - handlers must call `recorder.record` themselves. */
  recorder?: Recorder;
  /** Derives the Actor for the request. Typically reads session data off
   *  `request`. Defaults to a resolver that returns `{ type: "anonymous" }`. */
  resolveActor?: ActorResolver;
  /** Logger for diagnostics (auto-record failures). Defaults to console. */
  logger?: Logger;
}

const ANONYMOUS: Actor = { type: "anonymous" };

/** Handle installed between the `onRequest` hook (which begins it) and the
 *  `onResponse` hook (which ends it). Kept in a WeakMap rather than on
 *  `request` itself, since only `event` - the mutable Event handlers
 *  enrich - is meant to be public surface; `end()` is adapter-internal. */
const lifecycles = new WeakMap<FastifyRequest, RequestLifecycle>();

/** Returns a Fastify plugin that:
 *
 *  1. Builds an Event template (Actor from `resolveActor`, Origin from
 *     request headers) in an `onRequest` hook.
 *  2. Calls the core `begin` lifecycle, which installs an AsyncLocalStorage
 *     scope so `current()` and `newFromContext()` work for the duration of
 *     the request, and stamps an idempotency key on the request-scoped
 *     event.
 *  3. Installs an OutcomeCapture, backed by `resultFromHttpStatus`, so
 *     `prepareEvent` can auto-populate the event's Result from the final
 *     HTTP status when the handler hasn't set one explicitly.
 *  4. Exposes the request-scoped mutable Event on `request.event` for
 *     handlers to enrich (set Action, Target, Metadata, optionally Result),
 *     mirroring Express's `req.event`. This is the same object `current()`
 *     returns.
 *  5. If a recorder is configured, records `request.event` once from an
 *     `onResponse` hook - provided the handler set `request.event.action`.
 *     Empty Action is a no-op. The core lifecycle dedupes this against a
 *     handler that already recorded the same event manually, so both paths
 *     never submit twice.
 *
 *  Registration and hook timing, the one thing this adapter has to get
 *  right:
 *
 *  Fastify's `onResponse` hook fires only after a response has genuinely
 *  been sent - "executed when a response has been sent, so you will not be
 *  able to send more data to the client" per Fastify's own docs. That is a
 *  stronger guarantee than Express's `res.on("finish"/"close")` pair (close
 *  also fires when a client disconnects before anything was written, which
 *  is why expressMiddleware's capture has to check `headersSent`/
 *  `writableEnded` at read time). Here, if nothing is ever sent - a sync
 *  handler that never calls `reply.send()` - `onResponse` simply never
 *  fires, and end() never runs, so no event is auto-recorded for that
 *  in-flight request. `capture.outcome` still checks `reply.raw.headersSent`/
 *  `writableEnded` regardless, because that same capture is also read
 *  mid-handler by `prepareEvent` (e.g. when a handler records a
 *  `newFromContext()` clone before its own response is sent) - without the
 *  check, that read would report `reply.raw.statusCode`'s default 200
 *  instead of "no outcome yet".
 *
 *  A real limitation, not papered over: Fastify's own dispatcher does not
 *  leave an async handler's non-write alone. When an async route handler
 *  resolves without calling `reply.send()` (or returning a value), Fastify
 *  treats that as "send the resolved value" and sends an empty 200 anyway
 *  (see fastify's `lib/wrap-thenable.js`: a `payload` of `undefined` still
 *  reaches `reply.send(payload)` as long as the reply hasn't already been
 *  sent and the socket is alive). That fabricated 200 has already happened
 *  by the time `onResponse` fires, so this adapter cannot tell "the handler
 *  responded with an empty 200" from "the handler returned without
 *  responding" - both look identical once Fastify is done with them. This
 *  is the same class of problem sdk-go's fiber adapter documents (fasthttp's
 *  status defaults to 200 with no written flag), just triggered by a
 *  different mechanism: implicit auto-send-on-resolve rather than a status
 *  field with no commit flag at all. A sync handler that never calls
 *  `reply.send()` does not get this treatment - it simply hangs, and (per
 *  above) never triggers `onResponse` or an auto-record.
 *
 *  Mount this before route registration and after any auth plugin/hook,
 *  since `resolveActor` typically reads request-scoped identity.
 *
 *  Fastify encapsulates plugins registered via `app.register()` by default,
 *  so hooks added inside would only apply to routes registered as children
 *  of that specific register() call, not sibling routes on the parent
 *  instance. This plugin sets Fastify's own `Symbol.for("skip-override")`
 *  marker (native since Fastify v3) to skip that encapsulation, so the
 *  hooks apply app-wide - the same reach `app.use(expressMiddleware())` has
 *  for Express. No `fastify-plugin` dependency required. */
export function fastifyMiddleware(opts: FastifyMiddlewareOptions = {}): FastifyPluginAsync {
  const resolve = opts.resolveActor ?? (() => ANONYMOUS);
  const rec = opts.recorder;
  const logger = opts.logger ?? consoleLogger;

  const plugin: FastifyPluginAsync = async function everscribeFastifyPlugin(app) {
    app.addHook("onRequest", (request, reply, done) => {
      const template = new Event();
      template.actor = resolve(request);
      const origin = originFromRequest(request as unknown as RequestLike);
      if (origin.ip || origin.userAgent || origin.requestId) {
        template.origin = origin;
      }

      const capture: OutcomeCapture = {
        get outcome() {
          if (!reply.raw.headersSent && !reply.raw.writableEnded) return undefined;
          return resultFromHttpStatus(reply.raw.statusCode);
        },
      };

      const lifecycle = begin(template, capture, rec, logger);
      request.event = lifecycle.event;
      lifecycles.set(request, lifecycle);

      lifecycle.run(() => done());
    });

    app.addHook("onResponse", (request, _reply, done) => {
      lifecycles.get(request)?.end();
      lifecycles.delete(request);
      done();
    });
  };

  (plugin as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
  return plugin;
}
