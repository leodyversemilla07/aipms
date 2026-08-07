-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('new', 'classifying', 'extracted', 'matched', 'exception', 'dropped');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('received', 'matched', 'exception', 'paid');

-- AlterEnum
ALTER TYPE "PolicyKind" ADD VALUE 'taxRule';

-- CreateTable
CREATE TABLE "intakeDocument" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "senderId" TEXT,
    "raw" JSONB,
    "status" "IntakeStatus" NOT NULL DEFAULT 'new',
    "classified" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intakeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "poId" TEXT,
    "vendorId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "vatMinor" INTEGER NOT NULL DEFAULT 0,
    "ewtMinor" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "taxPolicyVersion" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'received',
    "matchResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intakeDocument_status_idx" ON "intakeDocument"("status");

-- CreateIndex
CREATE UNIQUE INDEX "intakeDocument_channel_contentHash_key" ON "intakeDocument"("channel", "contentHash");

-- CreateIndex
CREATE INDEX "invoice_status_idx" ON "invoice"("status");

-- CreateIndex
CREATE INDEX "invoice_poId_idx" ON "invoice"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_vendorId_number_key" ON "invoice"("vendorId", "number");
