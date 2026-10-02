-- Do not backfill provenance: historical auto content was not validated against
-- canonical records. Unsent legacy auto rows must be held for human review.
ALTER TABLE "message"
  ADD COLUMN "templateVersion" INTEGER,
  ADD COLUMN "templateParams" JSONB;
