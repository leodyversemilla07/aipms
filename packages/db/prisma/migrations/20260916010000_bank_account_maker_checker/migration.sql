-- Require separate finance principals to submit and verify beneficiary changes.
ALTER TABLE "vendor"
ADD COLUMN "bankAccountVerifiedBy" TEXT,
ADD COLUMN "bankAccountSubmittedBy" TEXT;

-- Existing verified records remain payable and are explicitly marked as
-- grandfathered. New writes always record the real verifier principal.
UPDATE "vendor"
SET "bankAccountVerifiedBy" = 'legacy-migration'
WHERE "bankAccountVerifiedAt" IS NOT NULL
  AND "bankAccountChangedAt" IS NULL;

-- Legacy changed accounts previously carried both timestamps. Preserve them as
-- pending submissions and require a real second user before payment.
UPDATE "vendor"
SET "bankAccountVerifiedAt" = NULL,
    "bankAccountVerifiedBy" = NULL,
    "bankAccountSubmittedBy" = 'legacy-migration'
WHERE "bankAccountChangedAt" IS NOT NULL;

ALTER TABLE "vendor"
ADD CONSTRAINT "vendor_bank_verified_pair_check"
CHECK (("bankAccountVerifiedAt" IS NULL) = ("bankAccountVerifiedBy" IS NULL)),
ADD CONSTRAINT "vendor_bank_submitted_pair_check"
CHECK (("bankAccountChangedAt" IS NULL) = ("bankAccountSubmittedBy" IS NULL)),
ADD CONSTRAINT "vendor_bank_state_check"
CHECK ("bankAccountVerifiedAt" IS NULL OR "bankAccountChangedAt" IS NULL);
