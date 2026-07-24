import type { NextFunction, Request, RequestHandler, Response } from "express";

import { Event, begin, resultFromHttpStatus } from "./event/event.js";
import { originFromRequest, type RequestLike } from "./event/origin.js";
import type { Actor, Logger, OutcomeCapture } from "./event/types.js";
import { consoleLogger } from "./recorder/logger.js";
import type { Recorder } from "./recorder/types.js";

declare global {
  namespace Express {
    interface Request {
      /** Mutable event installed by `expressMiddleware`. Auto-recorded on
       *  response finish/close when a recorder was configured. */
      event?: Event;
    }
  }
}

export type ActorResolver = (req: Request) => Actor;

export interface ExpressMiddlewareOptions {
  /** Recorder to send the per-request event to on response finish/close.
   *  When omitted, `req.event` is still installed but auto-record does
   *  not fire - handlers must call `recorder.record` themselves. */
  recorder?: Recorder;
  /** Derives the Actor for the request. Typically reads session data
   *  from `req.user`, `req.session`, or similar. Defaults to a resolver
   *  that returns `{ type: "anonymous" }`. */
  resolveActor?: ActorResolver;
  /** Logger for diagnostics (auto-record failures). Defaults to console. */
  logger?: Logger;
}

const ANONYMOUS: Actor = { type: "anonymous" };

/** Returns an Express middleware that:
 *
 *  1. Builds an Event template (Actor from `resolveActor`, Origin from
 *     request headers).
 *  2. Calls the core `begin` lifecycle, which installs an AsyncLocalStorage
 *     scope so `current()` and `newFromContext()` work for the duration of
 *     the request, and stamps an idempotency key on the request-scoped
 *     event.
 *  3. Installs an OutcomeCapture, backed by `resultFromHttpStatus`, so
 *     `prepareEvent` can auto-populate the event's Result from the final
 *     HTTP status when the handler hasn't set one explicitly.
 *  4. Exposes the request-scoped mutable Event on `req.event` for handlers
 *     to enrich (set Action, Target, Metadata, optionally Result). This is
 *     the same object `current()` returns - `req.event` is an Express
 *     convenience, not a separate source of truth.
 *  5. If a recorder is configured, records `req.event` once on the first
 *     of `res.on("finish")` or `res.on("close")` - provided the handler
 *     set `req.event.action`. Empty Action is a no-op. The core lifecycle
 *     dedupes this against a handler that already recorded the same event
 *     manually, so both paths never submit twice.
 *
 *  Auto-record errors are logged via the configured `logger` and never
 *  thrown; an audit failure must not break the user-facing response.
 *
 *  This middleware must run AFTER any session/auth middleware that
 *  attaches identity to the request - `resolveActor` typically reads
 *  session state. Typical chain: parsers → session → auth → audit → routes. */
export function expressMiddleware(opts: ExpressMiddlewareOptions = {}): RequestHandler {
  const resolve = opts.resolveActor ?? (() => ANONYMOUS);
  const rec = opts.recorder;
  const logger = opts.logger ?? consoleLogger;

  return function eventMiddleware(req: Request, res: Response, next: NextFunction): void {
    const template = new Event();
    template.actor = resolve(req);
    const origin = originFromRequest(req as unknown as RequestLike);
    if (origin.ip || origin.userAgent || origin.requestId) {
      template.origin = origin;
    }

    const capture: OutcomeCapture = {
      get outcome() {
        if (!res.headersSent && !res.writableEnded) return undefined;
        return resultFromHttpStatus(res.statusCode);
      },
    };

    const lifecycle = begin(template, capture, rec, logger);
    req.event = lifecycle.event;

    lifecycle.run(() => {
      if (rec) {
        const onEnd = () => lifecycle.end();
        res.once("finish", onEnd);
        res.once("close", onEnd);
      }
      next();
    });
  };
}
