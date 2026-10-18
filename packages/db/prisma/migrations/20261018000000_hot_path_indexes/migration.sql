-- PO lookup and date-ordered queues had no supporting indexes: the PO-by-
-- requisition scan (issue serialization + wake recovery) and BIR period-range
-- or newest-first reads on invoices and intake documents full-scanned.
CREATE INDEX "purchaseOrder_requisitionId_idx" ON "purchaseOrder"("requisitionId");
CREATE INDEX "invoice_receivedAt_idx" ON "invoice"("receivedAt");
CREATE INDEX "intakeDocument_receivedAt_idx" ON "intakeDocument"("receivedAt");
