-- Controlled operator recovery for ambiguous outbound-message failures.
ALTER TABLE "message"
  ADD COLUMN "deliveryResolution" TEXT,
  ADD COLUMN "deliveryResolutionEvidence" TEXT,
  ADD COLUMN "deliveryResolvedBy" TEXT,
  ADD COLUMN "deliveryResolvedAt" TIMESTAMP(3);

ALTER TABLE "message"
  ADD CONSTRAINT "message_delivery_resolution_complete_check"
  CHECK (
    (
      "deliveryResolution" IS NULL
      AND "deliveryResolutionEvidence" IS NULL
      AND "deliveryResolvedBy" IS NULL
      AND "deliveryResolvedAt" IS NULL
    )
    OR
    (
      "deliveryResolution" IN ('confirmed_sent', 'confirmed_not_sent')
      AND "deliveryResolutionEvidence" IS NOT NULL
      AND length(btrim("deliveryResolutionEvidence")) > 0
      AND "deliveryResolvedBy" IS NOT NULL
      AND "deliveryResolvedAt" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "message_delivery_resolution_checker_check"
  CHECK (
    "deliveryResolvedBy" IS NULL
    OR "approvedBy" IS NULL
    OR "deliveryResolvedBy" <> "approvedBy"
  ),
  ADD CONSTRAINT "message_confirmed_sent_status_check"
  CHECK (
    "deliveryResolution" <> 'confirmed_sent'
    OR "status" = 'sent'
  );

CREATE INDEX "message_deliveryResolvedAt_idx"
  ON "message"("deliveryResolvedAt");
