-- Preserve the maker identity for approval gates so the deciding checker can
-- be proven distinct. Backfill from the originating requisition or PO where
-- legacy rows have enough provenance.
ALTER TABLE "approval"
  ADD COLUMN "requestedBy" TEXT;

UPDATE "approval" AS approval
SET "requestedBy" = requisition."requestedBy"
FROM "requisition" AS requisition
WHERE approval."requisitionId" = requisition."id"
  AND (
    approval."decidedBy" IS NULL
    OR approval."decidedBy" <> requisition."requestedBy"
  );

UPDATE "approval" AS approval
SET "requestedBy" = purchase_order."issuedBy"
FROM "purchaseOrder" AS purchase_order
WHERE approval."requestedBy" IS NULL
  AND approval."poId" = purchase_order."id"
  AND (
    approval."decidedBy" IS NULL
    OR approval."decidedBy" <> purchase_order."issuedBy"
  );

-- Rows with no recoverable origin, including historical self-decisions, are
-- explicitly marked legacy rather than weakening the invariant for new rows.
UPDATE "approval"
SET "requestedBy" = 'system:legacy'
WHERE "requestedBy" IS NULL;

ALTER TABLE "approval"
  ALTER COLUMN "requestedBy" SET NOT NULL;

ALTER TABLE "approval"
  ADD CONSTRAINT "approval_maker_checker_check"
  CHECK (
    "requestedBy" IS NULL
    OR "decidedBy" IS NULL
    OR "requestedBy" <> "decidedBy"
  );

-- Record who voided a payment run and why. Legacy voids are explicitly marked
-- rather than silently grandfathered without provenance.
ALTER TABLE "paymentRun"
  ADD COLUMN "voidedBy" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidReason" TEXT;

UPDATE "paymentRun"
SET "voidedBy" = 'system:legacy',
    "voidedAt" = "updatedAt",
    "voidReason" = 'Legacy void before maker/checker enforcement'
WHERE "status" = 'voided';

ALTER TABLE "paymentRun"
  ADD CONSTRAINT "payment_run_approval_maker_checker_check"
  CHECK ("approvedBy" IS NULL OR "createdBy" <> "approvedBy"),
  ADD CONSTRAINT "payment_run_approval_pair_check"
  CHECK (("approvedBy" IS NULL) = ("approvedAt" IS NULL)),
  ADD CONSTRAINT "payment_run_execution_pair_check"
  CHECK (("executedBy" IS NULL) = ("executedAt" IS NULL)),
  ADD CONSTRAINT "payment_run_approved_state_check"
  CHECK (
    "status" NOT IN ('approved', 'executed', 'reconciled')
    OR "approvedBy" IS NOT NULL
  ),
  ADD CONSTRAINT "payment_run_executed_state_check"
  CHECK (
    "status" NOT IN ('executed', 'reconciled')
    OR "executedBy" IS NOT NULL
  ),
  ADD CONSTRAINT "payment_run_void_provenance_check"
  CHECK (
    "status" <> 'voided'
    OR (
      "voidedBy" IS NOT NULL
      AND "voidedAt" IS NOT NULL
      AND "voidReason" IS NOT NULL
      AND length(btrim("voidReason")) > 0
    )
  );

-- Explicit manual settlement of an ambiguous external dispatch is itself a
-- checker action and must not be performed by the principal that dispatched.
ALTER TABLE "erpJournalExport"
  ADD COLUMN "dispatchResolvedBy" TEXT,
  ADD COLUMN "dispatchResolvedAt" TIMESTAMP(3),
  ADD CONSTRAINT "erp_dispatch_maker_checker_check"
  CHECK (
    "dispatchResolvedBy" IS NULL
    OR "dispatchClaimedBy" IS NULL
    OR "dispatchResolvedBy" <> "dispatchClaimedBy"
  ),
  ADD CONSTRAINT "erp_dispatch_resolution_pair_check"
  CHECK (("dispatchResolvedBy" IS NULL) = ("dispatchResolvedAt" IS NULL));
