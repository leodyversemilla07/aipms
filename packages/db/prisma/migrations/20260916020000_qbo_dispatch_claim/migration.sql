-- Durable claim around the non-transactional QuickBooks POST. A claim remains
-- after an ambiguous failure so another request cannot silently duplicate it.
ALTER TABLE "erpJournalExport"
ADD COLUMN "dispatchClaimId" TEXT,
ADD COLUMN "dispatchClaimedBy" TEXT,
ADD COLUMN "dispatchStartedAt" TIMESTAMP(3),
ADD COLUMN "dispatchFailure" TEXT;

CREATE UNIQUE INDEX "erpJournalExport_dispatchClaimId_key"
ON "erpJournalExport"("dispatchClaimId");

ALTER TABLE "erpJournalExport"
ADD CONSTRAINT "erp_export_dispatch_claim_check"
CHECK (
  ("dispatchClaimId" IS NULL AND "dispatchClaimedBy" IS NULL AND "dispatchStartedAt" IS NULL)
  OR
  ("dispatchClaimId" IS NOT NULL AND "dispatchClaimedBy" IS NOT NULL AND "dispatchStartedAt" IS NOT NULL)
);
