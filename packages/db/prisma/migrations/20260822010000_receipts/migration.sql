-- §8.1 receipts: goods/services received against PO lines (3-way match leg).

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('recorded', 'cancelled');

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'recorded',
    "note" TEXT,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "poLineId" TEXT,
    "lineNo" INTEGER,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ea',

    CONSTRAINT "receiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_receiptNumber_key" ON "receipt"("receiptNumber");

-- CreateIndex
CREATE INDEX "receipt_poId_idx" ON "receipt"("poId");

-- CreateIndex
CREATE INDEX "receipt_vendorId_idx" ON "receipt"("vendorId");

-- CreateIndex
CREATE INDEX "receipt_status_idx" ON "receipt"("status");

-- CreateIndex
CREATE INDEX "receiptLine_receiptId_idx" ON "receiptLine"("receiptId");

-- AddForeignKey
ALTER TABLE "receiptLine" ADD CONSTRAINT "receiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
