import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkOutbox, formatCheck, type OutboxCheck } from "../../tools/check-outbox.js";
import { broker, type Fixture, startFixture } from "./harness.js";

// The outbox under failure: each test breaks one part of the pipeline while reservations are being
// made, brings it back, and expects check-outbox to find one order per hold.
//
// Same requirements as outbox.test.ts. These also stop and start the redpanda container.

const STOCK = 1_000;
/** Reservations made on each side of the failure: one batch in flight when it hits, one after. */
const WAVE = 200;

// A hard kill takes longer to recover from than check-outbox's default 60s allows for:
//   - the relay gets a new consumer name on restart, so the dead one's unacked entries come back
//     only through the 30s XAUTOCLAIM sweep, once they have been idle for 60s
//   - the broker keeps a dead consumer in the group until its 45s session timeout, and reassigns its
//     partitions only then
const RECOVERY_TIMEOUT_MS = 180_000;

function expectPass(check: OutboxCheck): void {
  expect(check.pass, formatCheck(check)).toBe(true);
}

describe("outbox under failure", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture?.stop();
  });

  it("loses nothing when the broker is killed and restarted", async () => {
    const eventId = await fixture.createEvent(STOCK);
    try {
      const inFlight = fixture.reserve(eventId, WAVE, "before");
      // Wait for the relay to pick entries up, so the broker dies with a produce in flight.
      await fixture.relayReading(eventId);
      await broker.kill();
      // Reserving only needs Redis, so it carries on; the entries wait in the stream.
      expect(await fixture.reserve(eventId, WAVE, "during")).toBe(WAVE);
      expect(await inFlight).toBe(WAVE);
    } finally {
      await broker.start();
    }

    const check = await checkOutbox(eventId, { timeoutMs: RECOVERY_TIMEOUT_MS });
    expectPass(check);
    expect(check.orders).toBe(2 * WAVE);
  });

  it("loses nothing when the relay is killed and restarted", async () => {
    const eventId = await fixture.createEvent(STOCK);
    try {
      const inFlight = fixture.reserve(eventId, WAVE, "before");
      // Wait for the relay to pick entries up, so it dies holding entries it has not acked.
      await fixture.relayReading(eventId);
      await fixture.relay.kill();
      expect(await fixture.reserve(eventId, WAVE, "during")).toBe(WAVE);
      expect(await inFlight).toBe(WAVE);
    } finally {
      await fixture.relay.start();
    }

    const check = await checkOutbox(eventId, { timeoutMs: RECOVERY_TIMEOUT_MS });
    expectPass(check);
    expect(check.orders).toBe(2 * WAVE);
  });

  it("loses nothing when the order service is killed and restarted", async () => {
    const eventId = await fixture.createEvent(STOCK);
    try {
      const inFlight = fixture.reserve(eventId, WAVE, "before");
      // Wait for the first order, so the consumer dies part-way through the backlog.
      await fixture.ordersArriving(eventId);
      await fixture.order.kill();
      expect(await fixture.reserve(eventId, WAVE, "during")).toBe(WAVE);
      expect(await inFlight).toBe(WAVE);
    } finally {
      await fixture.order.start();
    }

    const check = await checkOutbox(eventId, { timeoutMs: RECOVERY_TIMEOUT_MS });
    expectPass(check);
    expect(check.orders).toBe(2 * WAVE);
  });

  it("creates one order when the same Kafka message is produced twice more", async () => {
    const eventId = await fixture.createEvent(STOCK);
    expect(await fixture.reserve(eventId, 1, "user")).toBe(1);
    // The relay's own delivery has landed and made the order.
    expectPass(await checkOutbox(eventId));

    const message = await fixture.lastRelayedMessage(eventId);
    const duplicatesBefore = await fixture.orderMetric("order_events_duplicate_total");
    await fixture.produce([message, message]);

    const check = await checkOutbox(eventId);
    expectPass(check);
    expect(check.orders).toBe(1);
    // Both copies reached the handler and were recognised, rather than failing some other way.
    expect(await fixture.orderMetric("order_events_duplicate_total")).toBe(duplicatesBefore + 2);
  });
});
