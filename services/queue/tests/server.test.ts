import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createLogger } from "@flash/observability";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { type AppState, createApp } from "../src/http/app.js";
import { createQueueRouter } from "../src/http/routes.js";
import { EventNotFoundError, NotOpenError, type QueueService } from "../src/queue/service.js";
import { QueueUnavailableError } from "../src/redis/client.js";

// No Redis here: the app is given a stand-in service, so this file runs everywhere.

const logger = createLogger({ service: "queue", level: "silent" });

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
}

function appWith(service: Partial<QueueService>, nodeEnv = "test"): Express {
  return createApp({
    logger,
    routes: createQueueRouter({ service: service as QueueService, nodeEnv }),
  });
}

const asUser = { headers: { "x-dev-user": "u1" } };

describe("queue-svc probes", () => {
  it("answers /healthz, and /readyz while Redis answers", async () => {
    await withServer(createApp({ logger, redisReachable: async () => true }), async (url) => {
      const health = await fetch(`${url}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const ready = await fetch(`${url}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true, redis: true });
    });
  });

  it("is not ready while Redis is unreachable, but still healthy", async () => {
    await withServer(createApp({ logger, redisReachable: async () => false }), async (url) => {
      const ready = await fetch(`${url}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ok: false, redis: false });
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    });
  });

  it("is not ready once it is shutting down", async () => {
    const state: AppState = { shuttingDown: true };
    await withServer(createApp({ logger, state }), async (url) => {
      const ready = await fetch(`${url}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ok: false });
    });
  });

  it("serves the queue metrics", async () => {
    await withServer(appWith({}), async (url) => {
      const res = await fetch(`${url}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const name of [
        "queue_joins_total",
        "queue_status_requests_total",
        "queue_admitted_total",
        "queue_depth",
        "event_state",
        "admitter_tick_duration_seconds",
        "admitter_ticks_skipped_total",
      ]) {
        expect(text).toContain(`# TYPE ${name} `);
      }
    });
  });
});

describe("queue-svc errors", () => {
  it("answers 401 without a caller, before touching the queue", async () => {
    const service = {
      join: async () => {
        throw new Error("reached the service without a caller");
      },
    };
    await withServer(appWith(service), async (url) => {
      for (const headers of [{}, { "x-dev-user": "" }, { "x-dev-user": "   " }]) {
        const res = await fetch(`${url}/queue/evt/join`, { method: "POST", headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
      }
    });
  });

  it("ignores X-Dev-User outside development and test", async () => {
    await withServer(appWith({}, "production"), async (url) => {
      const res = await fetch(`${url}/queue/evt/status`, asUser);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });

  it("maps what the service throws to {code, message}", async () => {
    const failures: [Error, number, object][] = [
      [new EventNotFoundError("evt"), 404, { code: "EVENT_NOT_FOUND" }],
      [new NotOpenError(1_800_000_000_000), 409, { code: "NOT_OPEN", lobbyOpensAt: 1.8e12 }],
      [new QueueUnavailableError(new Error("ECONNREFUSED")), 503, { code: "QUEUE_UNAVAILABLE" }],
      [new Error("boom"), 500, { code: "INTERNAL" }],
    ];
    for (const [error, status, body] of failures) {
      const service = {
        status: async () => {
          throw error;
        },
      };
      await withServer(appWith(service), async (url) => {
        const res = await fetch(`${url}/queue/evt/status`, asUser);
        expect(res.status).toBe(status);
        const json = (await res.json()) as { message?: unknown };
        expect(json).toMatchObject(body);
        expect(typeof json.message).toBe("string");
      });
    }
  });

  it("answers an unknown route with a JSON 404", async () => {
    await withServer(appWith({}), async (url) => {
      const res = await fetch(`${url}/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
