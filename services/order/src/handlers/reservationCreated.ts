import { z } from "zod";
import { prisma } from "../db.js";
import type { HandlerResult, RelayedEvent } from "../events.js";

// The fields reserve.lua writes to the stream entry. Redis stores them all as strings, so the
// numeric ones are coerced. `eventId` here is the sale event, not the id this event is deduped on.
const reservation = z.object({
  holdId: z.string().min(1),
  eventId: z.string().min(1),
  userId: z.string().min(1),
  qty: z.coerce.number().int().min(1),
  /** Epoch milliseconds: the same instant Redis holds as the hold's score in the holds ZSET. */
  expiresAt: z.coerce.number().int().positive(),
});

/**
 * reservation.created -> one Order(HELD) row, however many times the event is delivered.
 *
 * Both inserts run in one transaction, so the event is never recorded as processed without its order
 * existing, and an order is never written for an event that was already handled. The consumer commits
 * the Kafka offset only after this resolves, which is after COMMIT.
 */
export async function handleReservationCreated(event: RelayedEvent): Promise<HandlerResult> {
  const { holdId, eventId, userId, qty, expiresAt } = reservation.parse(event.data);

  return prisma.$transaction(async (tx) => {
    // 1. Dedupe: has this exact event been processed? skipDuplicates is ON CONFLICT DO NOTHING, so
    //    0 rows inserted means it has, and step 2 is skipped.
    const claimed = await tx.processedEvent.createMany({
      data: [{ eventId: event.eventId }],
      skipDuplicates: true,
    });
    if (claimed.count === 0) {
      return "duplicate";
    }

    // 2. Create the order. Its id is the reservation id, a second safety net: a different event
    //    for a reservation that already has an order inserts nothing.
    await tx.order.createMany({
      data: [{ id: holdId, eventId, userId, qty, state: "HELD", expiresAt: new Date(expiresAt) }],
      skipDuplicates: true,
    });
    return "processed";
  });
}
