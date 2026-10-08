import { z } from "zod";

export const RESERVATION_CREATED = "reservation.created";

/** An event as the relay publishes it, parsed. Handlers receive this. */
export interface RelayedEvent {
  /** `<stream>:<entryId>`: one id per Redis stream entry, the key ProcessedEvent dedupes on. */
  eventId: string;
  type: string;
  /**
   * The whole message: the stream entry's own fields, as the strings Redis stored, plus `stream` and
   * `entryId`. A handler validates the fields it needs.
   */
  data: Record<string, unknown>;
}

/** "duplicate" means the event was already in ProcessedEvent, so nothing was written this time. */
export type HandlerResult = "processed" | "duplicate";

const envelope = z.looseObject({
  stream: z.string().min(1),
  entryId: z.string().min(1),
  type: z.string().min(1),
});

/** Throws for anything that is not a JSON object carrying `stream`, `entryId` and `type`. */
export function parseEvent(value: Buffer | null): RelayedEvent {
  if (!value) {
    throw new Error("message has no value");
  }
  const data = envelope.parse(JSON.parse(value.toString("utf8")));
  return { eventId: `${data.stream}:${data.entryId}`, type: data.type, data };
}
