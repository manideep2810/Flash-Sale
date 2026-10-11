-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "totalStock" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "lobbyOpensAt" TIMESTAMP(3) NOT NULL,
    "saleOpensAt" TIMESTAMP(3) NOT NULL,
    "admitRatePerSec" INTEGER NOT NULL DEFAULT 50,
    "admitTtlSec" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_saleOpensAt_idx" ON "Event"("saleOpensAt");
