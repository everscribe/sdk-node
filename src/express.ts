import type { NextFunction, Request, RequestHandler, Response } from "express";

import { Event, fromContext, prepareEvent, runWithEvent } from "./event/event.js";
import { originFromRequest, type RequestLike } from "./event/origin.js";
import type { Actor, Logger, StatusCapture } from "./event/types.js";
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
 *  2. Installs an AsyncLocalStorage scope so `fromContext()` returns
 *     fresh clones of the template for handlers that record multiple
 *     events per request.
 *  3. Installs a StatusCapture so `prepareEvent` can auto-populate the
 *     event's Result from the final HTTP status when the handler hasn't
 *     set one explicitly.
 *  4. Exposes a per-request mutable Event on `req.event` for handlers
 *     to enrich (set Action, Target, Metadata, optionally Result).
 *  5. If a recorder is configured, records `req.event` once on the
 *     first of `res.on("finish")` or `res.on("close")` - provided the
 *     handler set `req.event.action`. Empty Action is a no-op.
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

    const capture: StatusCapture = {
      get status() {
        return res.headersSent || res.writableEnded ? res.statusCode : 0;
      },
    };

    runWithEvent(template, capture, () => {
      const userEvent = fromContext();
      req.event = userEvent;

      if (rec) {
        let recorded = false;
        // Two reasons to re-enter the ALS scope here:
        //   (a) Node's EventEmitter does not propagate AsyncLocalStorage
        //       from listener-registration time to emit time.
        //   (b) Custom recorders may not call prepareEvent themselves,
        //       so the middleware applies it explicitly to honor the
        //       documented auto-Result-from-status behavior.
        const onEnd = () => {
          if (recorded) return;
          recorded = true;
          if (!userEvent.action) return;
          runWithEvent(template, capture, () => {
            prepareEvent(userEvent);
            rec.record(userEvent).catch((err) => {
              logger.error("everscribe: auto-record failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          });
        };
        res.once("finish", onEnd);
        res.once("close", onEnd);
      }

      next();
    });
  };
}
