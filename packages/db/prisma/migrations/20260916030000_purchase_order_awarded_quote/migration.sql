-- Preserve the commercial award that authorized each sourced purchase order.
ALTER TABLE "purchaseOrder"
ADD COLUMN "awardedQuoteId" TEXT;

CREATE UNIQUE INDEX "purchaseOrder_awardedQuoteId_key"
ON "purchaseOrder"("awardedQuoteId");

ALTER TABLE "purchaseOrder"
ADD CONSTRAINT "purchaseOrder_awardedQuoteId_fkey"
FOREIGN KEY ("awardedQuoteId") REFERENCES "quote"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
