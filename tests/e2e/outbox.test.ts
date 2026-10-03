import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkOutbox, formatCheck } from "../../tools/check-outbox.js";
import { type Fixture, startFixture } from "./harness.js";

// End-to-end test of the outbox path: reserve -> Redis stream -> relay -> Kafka -> order row.
//
// Needs the local stack (`make up`) with the order tables migrated (`make migrate`), and ports
// 3001-3003 free: the test starts its own ticket, relay and order services.
//
//   pnpm -C tests/e2e run test:e2e

const STOCK = 1_000;

describe("outbox", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture?.stop();
  });

  it("turns 1,000 reservations into 1,000 orders", async () => {
    const eventId = await fixture.createEvent(STOCK);
    expect(await fixture.reserve(eventId, STOCK, "user")).toBe(STOCK);

    const check = await checkOutbox(eventId);
    expect(check.pass, formatCheck(check)).toBe(true);
    expect(check.orders).toBe(STOCK);
  });
});
