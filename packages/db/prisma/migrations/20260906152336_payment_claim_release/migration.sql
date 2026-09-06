-- DropIndex
DROP INDEX "paymentRunLine_invoiceId_key";

-- CreateIndex
CREATE INDEX "paymentRunLine_invoiceId_idx" ON "paymentRunLine"("invoiceId");
