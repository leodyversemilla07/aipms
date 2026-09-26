-- Persist the SMTP/provider receipt used for delivery reconciliation.
ALTER TABLE "message"
  ADD COLUMN "transportMessageId" TEXT;

CREATE INDEX "message_transportMessageId_idx"
  ON "message"("transportMessageId");
