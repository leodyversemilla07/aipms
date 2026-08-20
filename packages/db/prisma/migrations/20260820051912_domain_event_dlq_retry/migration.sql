-- AlterTable
ALTER TABLE "domainEvent" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deadLetterReason" TEXT,
ADD COLUMN     "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "domainEvent_deadLetteredAt_idx" ON "domainEvent"("deadLetteredAt");
