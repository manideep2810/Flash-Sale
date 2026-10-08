-- CreateIndex
CREATE INDEX "Order_state_expiresAt_idx" ON "Order"("state", "expiresAt");
