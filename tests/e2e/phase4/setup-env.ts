// Runs before every Phase 4 test file. tools/check-invariants.ts reads its connection settings from
// the environment when it is imported, so they are set here, ahead of any import.
process.env.DATABASE_URL = "postgresql://app:app@localhost:5434/flashsale?schema=order_e2e";
process.env.PAYMENTS_DATABASE_URL =
  "postgresql://app:app@localhost:5434/flashsale?schema=payment_e2e";
process.env.REDIS_URL ??= "redis://localhost:6380";
// Must match TIMERS in support.ts.
process.env.PAYMENT_STALE_SEC = "5";
process.env.SWEEPER_INTERVAL_MS = "2000";
process.env.ORDER_WORKER_METRICS_URLS = "http://localhost:3006/metrics";
