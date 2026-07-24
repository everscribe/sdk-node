import type {
  Metadata,
  ServerInterceptingCallInterface,
  ServerInterceptor,
  ServerMethodDefinition,
  status as GrpcStatus,
} from "@grpc/grpc-js";
import { ResponderBuilder, ServerInterceptingCall, ServerListenerBuilder, status } from "@grpc/grpc-js";

import { begin, Event, type RequestLifecycle } from "./event/event.js";
import type { Actor, Logger, Origin, OutcomeCapture, Result } from "./event/types.js";
import { consoleLogger } from "./recorder/logger.js";
import type { Recorder } from "./recorder/types.js";

/** What `resolveActor` sees: the pieces of an incoming call available at the
 *  moment request metadata arrives, bundled the way `Request`/`FastifyRequest`/
 *  `Context` are for the HTTP adapters. There is no single "request object"
 *  for a gRPC server call, so this is synthesized rather than passed through
 *  from grpc-js as-is. */
export interface GrpcCallInfo {
  /** Full RPC method name, e.g. "/everscribe.v1.Ingest/Record". */
  method: string;
  /** Incoming request metadata. */
  metadata: Metadata;
  /** Remote peer IP, when known (empty over a transport that doesn't expose
   *  one, e.g. a Unix domain socket). */
  peer: string;
}

export type ActorResolver = (info: GrpcCallInfo) => Actor;

export interface GrpcServerInterceptorOptions {
  /** Recorder to send the per-call event to once the call has finished
   *  (`sendStatus` has fired). When omitted, `current()` still works for the
   *  duration of the call but auto-record does not fire - handlers must call
   *  `recorder.record` themselves. */
  recorder?: Recorder;
  /** Derives the Actor for the call. Typically reads identity out of request
   *  metadata (e.g. a bearer token already validated by an auth interceptor
   *  earlier in the chain). Defaults to a resolver that returns
   *  `{ type: "anonymous" }`. */
  resolveActor?: ActorResolver;
  /** Logger for diagnostics (auto-record failures). Defaults to console. */
  logger?: Logger;
}

const ANONYMOUS: Actor = { type: "anonymous" };

/** Returns a grpc-js server interceptor that:
 *
 *  1. Builds an Event template (Actor from `resolveActor`, Origin from
 *     request metadata) as soon as metadata arrives for the call.
 *  2. Calls the core `begin` lifecycle, which installs an AsyncLocalStorage
 *     scope so `current()` and `newFromContext()` work for the duration of
 *     the handler, and stamps an idempotency key on the call-scoped event.
 *  3. Defaults `event.action` to the full RPC method name (e.g.
 *     "/everscribe.v1.Ingest/Record"), so every RPC records unless a handler
 *     clears it. This deliberately differs from the HTTP adapters, which
 *     record nothing until a handler names the event: there is no
 *     equivalent of an HTTP router path that is meaningful without a
 *     handler-chosen action, since the RPC method name already *is* the
 *     action a gRPC service was built around. sdk-go's grpc adapter does the
 *     same (see `UnaryInterceptor` in adapter_grpc.go).
 *  4. Installs an OutcomeCapture, backed by `resultFromGrpcStatus`, so
 *     `prepareEvent` can auto-populate the event's Result from the status
 *     the call finishes with when the handler hasn't set one explicitly.
 *  5. If a recorder is configured, records the call-scoped event once the
 *     call's status has been sent - provided the handler (or the method-name
 *     default from step 3) left `action` non-empty. The core lifecycle
 *     dedupes this against a handler that already recorded the same event
 *     manually, so both paths never submit twice.
 *
 *  `action` is stamped on the call-scoped event returned by `begin`, not on
 *  the template passed into it. Stamping the template would leak the method
 *  name into every `newFromContext()` clone a handler makes - a secondary
 *  event the handler never named would then inherit the RPC method name
 *  instead of being dropped by the empty-action no-op every stock recorder
 *  applies. sdk-go's grpc adapter documents the same bug, caught in review
 *  there before it shipped.
 *
 *  ## Why `onReceiveMetadata` builds the lifecycle but `onReceiveHalfClose`
 *  ## is what gets wrapped
 *
 *  `current()` relies on Node's AsyncLocalStorage, which only propagates
 *  into a synchronous continuation of whatever call installed it. For a
 *  unary RPC, grpc-js's own server code (`handleUnary` in
 *  `@grpc/grpc-js/build/src/server.js`) invokes the registered handler
 *  function synchronously from its listener's `onReceiveHalfClose` hook -
 *  not from `responder.start`'s `next()`, which only registers the call as
 *  ready to receive inbound stream events and returns immediately, well
 *  before the handler ever runs. A server interceptor can supply its own
 *  listener via `next(listener)` inside `responder.start`; wrapping *that*
 *  listener's `onReceiveHalfClose(next)` continuation in `lifecycle.run(...)`
 *  - the same method Express/Fastify/Hono already use - is what makes
 *  `current()` resolve correctly inside a gRPC handler. See
 *  `.grpc-spike.md` for the traced call graph and the naive alternative that
 *  was tried and rejected (wrapping `responder.start`'s `next()` directly,
 *  which compiles and runs but silently produces a throwaway event).
 *
 *  Metadata, not half-close, is where the template has to be built: Actor
 *  and Origin need the incoming request metadata, and `onReceiveMetadata`
 *  fires before `onReceiveHalfClose` for every call shape grpc-js supports
 *  (headers always precede the request body's end on the wire). Building the
 *  template one hook earlier than the hook that gets wrapped costs nothing -
 *  `begin` itself does no I/O - and keeps `resolveActor` working the same
 *  way it does for the HTTP adapters: synchronously, off data already on the
 *  wire.
 *
 *  ## Unary only
 *
 *  This interceptor supports unary RPCs. Streaming was not implemented and
 *  is deliberately left out rather than shipped half-verified:
 *  `handleClientStreaming` and `handleBidiStreaming` invoke the handler
 *  function synchronously from `onReceiveMetadata`, not `onReceiveHalfClose`
 *  - by the time this interceptor's wrapped `onReceiveHalfClose` continuation
 *  would run, the handler has already executed outside any lifecycle scope,
 *  so `current()` would silently return a throwaway event instead of
 *  failing loudly. `handleServerStreaming` happens to invoke the handler
 *  from `onReceiveHalfClose` like unary does, but a streaming handler's
 *  response shape (multiple `sendMessage` calls, the handler ending the
 *  stream itself) was never exercised against this interceptor, so it is
 *  not claimed to work either.
 *
 *  To keep a mixed unary/streaming service from silently mis-recording
 *  streaming calls, this interceptor detects `requestStream`/
 *  `responseStream` on the method descriptor and passes those calls through
 *  untouched - no lifecycle, no auto-record, `current()` behaves as if this
 *  interceptor were not installed. A streaming adapter is a real gap to fill
 *  later, not something to fake here.
 *
 *  Mount with `new grpc.Server({ interceptors: [grpcServerInterceptor(opts)] })`.
 *  Handlers call `current()` exactly as they would inside an Express route. */
export function grpcServerInterceptor(opts: GrpcServerInterceptorOptions = {}): ServerInterceptor {
  const resolve = opts.resolveActor ?? (() => ANONYMOUS);
  const rec = opts.recorder;
  const logger = opts.logger ?? consoleLogger;

  return function everscribeGrpcInterceptor(
    methodDescriptor: ServerMethodDefinition<unknown, unknown>,
    call: ServerInterceptingCallInterface,
  ): ServerInterceptingCall {
    if (methodDescriptor.requestStream || methodDescriptor.responseStream) {
      // Streaming call: pass through untouched. See the "Unary only" section
      // of this function's doc comment.
      return new ServerInterceptingCall(call);
    }

    let lifecycle: RequestLifecycle | undefined;
    let capturedResult: Result | undefined;

    const capture: OutcomeCapture = {
      get outcome() {
        return capturedResult;
      },
    };

    const responder = new ResponderBuilder()
      .withStart((next) => {
        next(
          new ServerListenerBuilder()
            .withOnReceiveMetadata((metadata, nextMetadata) => {
              const template = new Event();
              const info: GrpcCallInfo = {
                method: methodDescriptor.path,
                metadata,
                peer: call.getConnectionInfo().remoteAddress ?? "",
              };
              template.actor = resolve(info);
              const origin = originFromGrpc(info);
              if (origin.ip || origin.userAgent || origin.requestId) {
                template.origin = origin;
              }

              lifecycle = begin(template, capture, rec, logger);
              lifecycle.event.action = methodDescriptor.path;

              nextMetadata(metadata);
            })
            .withOnReceiveHalfClose((cont) => {
              // lifecycle is always set by this point: onReceiveMetadata
              // fires before onReceiveHalfClose for every call shape
              // grpc-js supports (see server.js's handleUnary/
              // handleServerStreaming/handleClientStreaming/
              // handleBidiStreaming, all of which call `call.start` with
              // metadata handled first). Falling back to a bare `cont()`
              // keeps this defensive rather than throwing if that ever
              // changes.
              if (!lifecycle) {
                cont();
                return;
              }
              lifecycle.run(() => cont());
            })
            .build(),
        );
      })
      .withSendStatus((responseStatus, next) => {
        capturedResult = resultFromGrpcStatus(responseStatus.code, responseStatus.details);
        lifecycle?.end();
        next(responseStatus);
      })
      .build();

    return new ServerInterceptingCall(call, responder);
  };
}

function originFromGrpc(info: GrpcCallInfo): Origin {
  const header = (name: string): string => {
    const value = info.metadata.get(name)[0];
    return typeof value === "string" ? value : "";
  };
  const o: Origin = {};
  const ip = clientIpFromGrpc(header, info.peer);
  if (ip) o.ip = ip;
  const ua = header("user-agent");
  if (ua) o.userAgent = ua;
  const rid = header("x-request-id");
  if (rid) o.requestId = rid;
  return o;
}

function clientIpFromGrpc(header: (name: string) => string, peerAddress: string): string {
  const xff = header("x-forwarded-for");
  if (xff) {
    const comma = xff.indexOf(",");
    return (comma >= 0 ? xff.slice(0, comma) : xff).trim();
  }
  const xri = header("x-real-ip");
  if (xri) return xri;
  return peerAddress;
}

/** Derives a Result from a gRPC status code and its details string. Opt-in:
 *  core never calls this implicitly, same contract as `resultFromHttpStatus`.
 *
 *  `Result.code` carries the canonical HTTP equivalent of `code`, never the
 *  native gRPC code - see `httpStatusForGrpcCode`'s doc comment for why.
 *  A successful call (`status.OK`, native code 0) always yields
 *  `{ status: "ok", code: 200 }` with no `message`, matching how
 *  `resultFromHttpStatus` handles a plain 200: grpc-js's own framework code
 *  sets a non-empty `details: "OK"` on every successful unary response
 *  (see `respond()` in `server.js`), and surfacing that as `Result.message`
 *  would put framework boilerplate on every successful event for no reason.
 *  Non-OK codes keep `details` as `message` when non-empty. */
export function resultFromGrpcStatus(code: GrpcStatus, details: string): Result {
  if (code === status.OK) return { status: "ok", code: 200 };
  const httpCode = httpStatusForGrpcCode(code);
  const r: Result = {
    status: httpCode === 401 || httpCode === 403 ? "denied" : "error",
    code: httpCode,
  };
  if (details) r.message = details;
  return r;
}

/** Maps a native gRPC status code to its canonical HTTP equivalent, following
 *  the grpc-gateway / Google API design guide mapping. Ports sdk-go's
 *  `HTTPStatusFor` (pkg/event/adapter_codes.go) case for case - grpc-js's
 *  `status` enum is numerically identical to Go's `google.golang.org/grpc/codes`
 *  (both are the same wire-level 0-16 gRPC status space), so no
 *  reinterpretation was needed.
 *
 *  `Result.Code` carries this rather than the native gRPC code, deliberately.
 *  Native codes break two things: code 0 (OK) is dropped by every SDK's
 *  wire encoder (this one included, via `undefined` fields being omitted),
 *  so `result.code` would never match a successful gRPC call; and native
 *  codes 1-16 collide with unrelated HTTP-native codes in the same numeric
 *  range, which the NLP query layer's priors assume mean HTTP status (e.g.
 *  "forbidden" maps to 403, not gRPC's native 7).
 *
 *  The cost is accepted: INVALID_ARGUMENT, FAILED_PRECONDITION, and
 *  OUT_OF_RANGE all collapse to 400, so the exact gRPC code is not
 *  recoverable from the event. The full status message is preserved in
 *  `Result.message`. */
export function httpStatusForGrpcCode(code: GrpcStatus): number {
  switch (code) {
    case status.OK:
      return 200;
    case status.CANCELLED:
      return 499; // nginx's client-closed-request; no standard HTTP name for it
    case status.INVALID_ARGUMENT:
    case status.FAILED_PRECONDITION:
    case status.OUT_OF_RANGE:
      return 400;
    case status.UNAUTHENTICATED:
      return 401;
    case status.PERMISSION_DENIED:
      return 403;
    case status.NOT_FOUND:
      return 404;
    case status.ALREADY_EXISTS:
    case status.ABORTED:
      return 409;
    case status.RESOURCE_EXHAUSTED:
      return 429;
    case status.UNIMPLEMENTED:
      return 501;
    case status.UNAVAILABLE:
      return 503;
    case status.DEADLINE_EXCEEDED:
      return 504;
    default: // UNKNOWN, INTERNAL, DATA_LOSS
      return 500;
  }
}
