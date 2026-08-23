-- §8.5 ERP integration: governed journal exports (publish what you own).

-- CreateTable
CREATE TABLE "erpJournalExport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "status" TEXT NOT NULL DEFAULT 'exported',
    "externalRef" TEXT,
    "rejectedReason" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "exportedBy" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erpJournalExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erpJournalExport_runId_key" ON "erpJournalExport"("runId");

-- CreateIndex
CREATE INDEX "erpJournalExport_status_idx" ON "erpJournalExport"("status");
