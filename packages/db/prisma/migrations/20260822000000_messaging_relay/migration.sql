-- §8.3 vendor messaging relay: outbound outbox with tiered gates.

-- CreateEnum
CREATE TYPE "MessageTier" AS ENUM ('auto', 'gated');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'approved', 'rejected', 'sent', 'failed');

-- CreateTable
CREATE TABLE "message" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "templateId" TEXT,
    "tier" "MessageTier" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'queued',
    "agentId" TEXT,
    "runId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "failedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_vendorId_idx" ON "message"("vendorId");

-- CreateIndex
CREATE INDEX "message_status_idx" ON "message"("status");

-- CreateIndex
CREATE INDEX "message_threadId_idx" ON "message"("threadId");
