import type { PoolClient } from "pg";

export const VARIANTS = ["naive", "pessimistic", "atomic", "optimistic"] as const;
export type Variant = (typeof VARIANTS)[number];

export function isVariant(value: string): value is Variant {
  return (VARIANTS as readonly string[]).includes(value);
}

export type ReserveResult = ({ ok: true; holdId: string } | { ok: false; reason: "SOLD_OUT" }) & {
  /** Version-conflict retries this call needed. Only variants that retry (optimistic) set it. */
  retries?: number;
};

/**
 * One reservation attempt. The caller hands over a dedicated client (not the pool) so a variant can
 * open a transaction, take locks, or retry on serialization/version conflicts as it sees fit.
 */
export type Reserve = (
  client: PoolClient,
  eventId: string,
  userId: string,
  qty: number,
) => Promise<ReserveResult>;
