-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "holdSettledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_holdSettledAt_state_idx" ON "Order"("holdSettledAt", "state");

