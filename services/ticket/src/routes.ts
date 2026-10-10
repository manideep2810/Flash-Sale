import { getCallerId } from "@flash/auth";
import type { Logger } from "@flash/observability";
import { type Request, type RequestHandler, type Response, Router } from "express";
import { z } from "zod";
import { ADMISSION_HEADER, AdmissionError, type RequireAdmission } from "./admission.js";
import { type RedisPool, type ReserveScript, resetEvent } from "./redis/index.js";

// No userId: who is reserving is the session's user, never a field the caller fills in. A userId
// sent anyway (the Postgres variants still take one) is dropped unread.
const reserveBody = z.object({
  eventId: z.string().min(1),
  qty: z.number().int().min(1),
});

const resetBody = z.object({
  eventId: z.string().min(1),
  total: z.number().int().min(0),
});

export interface RedisRouterOptions {
  script: ReserveScript;
  pool: RedisPool;
  logger: Logger;
  /** requireSession() from @flash/auth: /redis/reserve needs a caller before it needs anything else. */
  authenticate: RequestHandler;
  /** The admission check, run for that caller before body validation and any Redis command. */
  requireAdmission: RequireAdmission;
}

/** The event being reserved, as the body names it: the value reserve.lua is run for. */
function eventIdOf(req: Request): string {
  const eventId = (req.body as { eventId?: unknown } | undefined)?.eventId;
  return typeof eventId === "string" ? eventId : "";
}

export function createRedisRouter({
  script,
  pool,
  logger,
  authenticate,
  requireAdmission,
}: RedisRouterOptions): Router {
  const router = Router();

  // POST /redis/reserve  {eventId, qty} + Authorization: Bearer <session> + X-Admission-Token
  //   -> 201 {holdId} | 409 {error: "SOLD_OUT"}
  //    | 401 {code} from the session check | 401, 403 {code, message} from the admission check
  router.post("/redis/reserve", authenticate, async (req: Request, res: Response) => {
    // The caller is whoever the session says (getCallerId reads nothing the client can set). Then,
    // ahead of body validation and of every Redis command, the admission check: a caller the waiting
    // room has not admitted costs this service two signature checks and nothing more.
    const callerId = getCallerId(req);
    try {
      await requireAdmission(req.get(ADMISSION_HEADER), callerId, eventIdOf(req));
    } catch (error) {
      if (error instanceof AdmissionError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      logger.error("admission check failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
      return;
    }

    const parsed = reserveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, qty } = parsed.data;

    const startedAt = performance.now();
    let result: "ok" | "sold_out" | "error" = "error";
    try {
      const outcome = await script.reserve(eventId, callerId, qty);
      if (outcome.ok) {
        result = "ok";
        res.status(201).json({ holdId: outcome.holdId });
      } else {
        result = "sold_out";
        res.status(409).json({ error: outcome.reason });
      }
    } catch (error) {
      logger.error("redis reserve failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    } finally {
      logger.info("redis reserve", {
        variant: "redis",
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        result,
      });
    }
  });

  // POST /redis/reset  {eventId, total} -> inventory back to total, holds and stream emptied.
  // Body and response mirror /baseline/reset so one k6 setup() can reset either backend.
  router.post("/redis/reset", async (req: Request, res: Response) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BAD_REQUEST", issues: z.prettifyError(parsed.error) });
      return;
    }
    const { eventId, total } = parsed.data;

    try {
      await resetEvent(pool, eventId, total);
      res.json({ status: "reset", eventId, total, available: total, holdsQty: 0 });
    } catch (error) {
      logger.error("redis reset failed", { error: describe(error) });
      res.status(500).json({ error: "INTERNAL", message: describe(error) });
    }
  });

  return router;
}

/** Mirrors the helper in src/baseline/routes.ts; `code` is a Redis reply prefix or a Node errno. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
