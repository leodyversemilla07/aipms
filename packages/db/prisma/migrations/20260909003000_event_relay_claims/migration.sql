-- Coordinate outbox delivery across API replicas and make event-triggered
-- agent runs idempotent under at-least-once delivery.
ALTER TABLE "DomainEvent"
  ADD COLUMN "processingAt" TIMESTAMP(3),
  ADD COLUMN "processingBy" TEXT;

CREATE INDEX "DomainEvent_processingAt_idx" ON "DomainEvent"("processingAt");

ALTER TABLE "agentRun" ADD COLUMN "triggerEventId" TEXT;
CREATE UNIQUE INDEX "agentRun_triggerEventId_key" ON "agentRun"("triggerEventId");
