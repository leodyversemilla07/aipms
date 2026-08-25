-- §8.1 sourcing: structured vendor quotes + §10.3 approval SLA escalation.

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('requested', 'received', 'accepted', 'rejected');

-- AlterTable
ALTER TABLE "approval" ADD COLUMN "escalatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "quote" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'requested',
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "totalMinor" INTEGER,
    "leadTimeDays" INTEGER,
    "validUntil" TIMESTAMP(3),
    "lines" JSONB,
    "payload" JSONB,
    "awardedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quote_requisitionId_vendorId_key" ON "quote"("requisitionId", "vendorId");

-- CreateIndex
CREATE INDEX "quote_status_idx" ON "quote"("status");

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
