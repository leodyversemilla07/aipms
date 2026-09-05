-- Do not backfill from live vendor records: legacy approval did not cover them.
ALTER TABLE "paymentRunLine" ADD COLUMN "beneficiarySnapshot" JSONB;
