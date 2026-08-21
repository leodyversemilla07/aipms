-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "entryHash" TEXT,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AuditEntry_seq_key" ON "AuditEntry"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEntry_entryHash_key" ON "AuditEntry"("entryHash");
