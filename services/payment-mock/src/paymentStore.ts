import { prisma } from "./db.js";

export type PaymentStatus = "PROCESSING" | "SUCCEEDED" | "FAILED";

export interface PaymentRecord {
  orderId: string;
  amount: number;
  status: PaymentStatus;
  chargeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Payment table, owned by this service: nothing else reads or writes it. Every transition is a
 * guarded write, so concurrent or repeated requests for one order cannot both win a step.
 */
export interface PaymentStore {
  /** INSERT ... ON CONFLICT DO NOTHING with status PROCESSING. True when this call created the row. */
  insertProcessing(orderId: string, amount: number): Promise<boolean>;
  find(orderId: string): Promise<PaymentRecord | undefined>;
  /**
   * Takes over a PROCESSING row nobody has written to for `staleMs` (its worker died mid-charge) by
   * refreshing `updatedAt`. True for exactly one caller, so two redeliveries do not both re-charge.
   */
  claimStale(orderId: string, staleMs: number): Promise<boolean>;
  /** PROCESSING -> SUCCEEDED | FAILED. False when the row was no longer PROCESSING. */
  complete(orderId: string, status: "SUCCEEDED" | "FAILED", chargeId: string): Promise<boolean>;
}

export function createPrismaStore(): PaymentStore {
  return {
    async insertProcessing(orderId, amount) {
      const { count } = await prisma.payment.createMany({
        // idempotencyKey is the order id: one payment per order, whoever asks and however often.
        data: [
          { orderId, idempotencyKey: orderId, amount, status: "PROCESSING", updatedAt: new Date() },
        ],
        skipDuplicates: true,
      });
      return count === 1;
    },

    async find(orderId) {
      const row = await prisma.payment.findUnique({ where: { orderId } });
      return row ? { ...row, status: row.status as PaymentStatus } : undefined;
    },

    async claimStale(orderId, staleMs) {
      const { count } = await prisma.payment.updateMany({
        where: {
          orderId,
          status: "PROCESSING",
          updatedAt: { lt: new Date(Date.now() - staleMs) },
        },
        data: { updatedAt: new Date() },
      });
      return count === 1;
    },

    async complete(orderId, status, chargeId) {
      const { count } = await prisma.payment.updateMany({
        where: { orderId, status: "PROCESSING" },
        data: { status, chargeId },
      });
      return count === 1;
    },
  };
}
