// Untagged names, like the Phase 2 inventory keys they sit beside. A standalone Redis or a Sentinel set
// has one keyspace and no slots, so admit.lua can read avail and holds next to the queue keys. Redis
// Cluster would need one shared hash tag across all of them (see reserveKeys() in
// services/ticket/src/redis/index.ts).

/** Set of event ids that have a waiting room; the admitter iterates it. */
export const QUEUE_EVENTS = "queue:events";

/** Sorted set: userId -> lottery value in [0,1) (joined in the lobby) or join time in ms. */
export const queueKey = (eventId: string): string => `ev:${eventId}:queue`;

/** Hash: userId -> admittedAt in ms. */
export const admittedKey = (eventId: string): string => `ev:${eventId}:admitted`;

/** String: OPEN | PAUSED | SOLD_OUT. Written only by admit.lua. */
export const stateKey = (eventId: string): string => `ev:${eventId}:state`;

/** Hash: lobbyOpensAt, saleOpensAt (epoch ms), admitRatePerSec, admitTtlSec. */
export const configKey = (eventId: string): string => `ev:${eventId}:config`;

/**
 * Owned by the ticket service (reserveKeys() in services/ticket/src/redis/index.ts) and kept in step
 * with it by hand. Read-only here: admit.lua looks at them and nothing in this service writes them.
 */
export const availKey = (eventId: string): string => `ev:${eventId}:avail`;
export const holdsKey = (eventId: string): string => `ev:${eventId}:holds`;
