-- Run traces filter audit entries by the originating agent execution.
CREATE INDEX "AuditEntry_runId_idx" ON "AuditEntry"("runId");
