-- Bounded staged outbox polling and aged dispatch monitoring.
CREATE INDEX "message_status_createdAt_id_idx" ON "message"("status", "createdAt", "id");
CREATE INDEX "message_status_updatedAt_idx" ON "message"("status", "updatedAt");
CREATE INDEX "message_status_dispatchStartedAt_idx" ON "message"("status", "dispatchStartedAt");
