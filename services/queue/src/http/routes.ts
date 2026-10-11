import { getCallerId } from "@flash/auth";
import type { Logger } from "@flash/observability";
import {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { queueJoins, queueStatusRequests } from "../metrics.js";
import { EventNotFoundError, NotOpenError, type QueueService } from "../queue/service.js";
import { QueueUnavailableError } from "../redis/client.js";

export interface QueueRouterOptions {
  service: QueueService;
  /** requireSession() from @flash/auth: both routes need a caller, and it is who the session says. */
  authenticate: RequestHandler;
}

type EventParams = { eventId: string };

const UNAVAILABLE_LOG_MS = 5_000;

// The handlers only map HTTP to the service and back. What they throw is turned into a response by
// errorHandler() below: Express 5 forwards a rejected async handler to it.
//
// The counters are moved after the service answers, so their `event` label only ever holds an event
// that exists, not whatever a caller put in the URL.
export function createQueueRouter({ service, authenticate }: QueueRouterOptions): Router {
  const router = Router();

  /**
   * GET /queue/:eventId/info
   *   200 {eventId, name, price, lobbyOpensAt, saleOpensAt, admitRatePerSec, state}
   * What the event page shows. Reads the event's config and state; it does not look at the caller's
   * place in line, and joining is not needed to ask.
   */
  router.get(
    "/queue/:eventId/info",
    authenticate,
    async (req: Request<EventParams>, res: Response) => {
      res.json(await service.info(req.params.eventId));
    },
  );

  /**
   * POST /queue/:eventId/join
   *   200 {status: "QUEUED", position, peopleAhead, estWaitSec, retryAfterMs, phase}
   *   200 {status: "ADMITTED"}   call status for the token
   *   200 {status: "SOLD_OUT"}
   *   409 {code: "NOT_OPEN", lobbyOpensAt}
   * Safe to repeat: a queued user keeps their place.
   */
  router.post(
    "/queue/:eventId/join",
    authenticate,
    async (req: Request<EventParams>, res: Response) => {
      const { eventId } = req.params;
      const result = await service.join(eventId, getCallerId(req));
      queueJoins.inc({ event: eventId });
      res.json(result);
    },
  );

  /**
   * GET /queue/:eventId/status
   *   200 {status: "ADMITTED", token, expiresAt}
   *   200 {status: "QUEUED", state, position, peopleAhead, estWaitSec, retryAfterMs, phase}
   *   200 {status: "EXPIRED" | "SOLD_OUT" | "NOT_IN_QUEUE"}
   * A reply without retryAfterMs means stop polling.
   */
  router.get(
    "/queue/:eventId/status",
    authenticate,
    async (req: Request<EventParams>, res: Response) => {
      const { eventId } = req.params;
      const result = await service.status(eventId, getCallerId(req));
      queueStatusRequests.inc({ event: eventId, status: result.status });
      res.json(result);
    },
  );

  return router;
}

/** Anything no route matched, as JSON like every other error. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ code: "NOT_FOUND", message: "no such route" });
};

/** Every error leaves as JSON {code, message}. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  let unavailableLoggedAt = Number.NEGATIVE_INFINITY;
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof EventNotFoundError) {
      res.status(404).json({ code: "EVENT_NOT_FOUND", message: error.message });
      return;
    }
    if (error instanceof NotOpenError) {
      res.status(409).json({
        code: "NOT_OPEN",
        message: error.message,
        lobbyOpensAt: error.lobbyOpensAt,
      });
      return;
    }
    if (error instanceof QueueUnavailableError) {
      // Never "let them through": with Redis away nobody is queued and nobody is admitted. Every
      // poller fails at once in an outage, so this is logged every few seconds, not per request.
      const now = performance.now();
      if (now - unavailableLoggedAt >= UNAVAILABLE_LOG_MS) {
        unavailableLoggedAt = now;
        logger.error("redis unavailable", { path: req.originalUrl, error: String(error.cause) });
      }
      res.status(503).json({ code: "QUEUE_UNAVAILABLE", message: "try again shortly" });
      return;
    }
    logger.error("request failed", { path: req.originalUrl, error });
    res.status(500).json({ code: "INTERNAL", message: "internal error" });
  };
}
