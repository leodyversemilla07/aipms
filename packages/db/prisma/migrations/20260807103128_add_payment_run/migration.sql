-- CreateEnum
CREATE TYPE "PaymentRunStatus" AS ENUM ('draft', 'approved', 'executed', 'reconciled', 'voided');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('planned', 'paid', 'dishonored', 'rejected');

-- AlterTable
ALTER TABLE "vendor" ADD COLUMN     "bankAccount" JSONB,
ADD COLUMN     "bankAccountChangedAt" TIMESTAMP(3),
ADD COLUMN     "bankAccountVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "paymentRun" (
    "id" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "status" "PaymentRunStatus" NOT NULL DEFAULT 'draft',
    "totalMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "notes" JSONB,
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paymentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paymentRunLine" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paymentRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "paymentRun_runNumber_key" ON "paymentRun"("runNumber");

-- CreateIndex
CREATE INDEX "paymentRun_status_idx" ON "paymentRun"("status");

-- CreateIndex
CREATE INDEX "paymentRunLine_runId_idx" ON "paymentRunLine"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "paymentRunLine_invoiceId_key" ON "paymentRunLine"("invoiceId");

-- AddForeignKey
ALTER TABLE "paymentRunLine" ADD CONSTRAINT "paymentRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "paymentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
