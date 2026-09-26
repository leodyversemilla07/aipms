-- Keep event-triggered agent runs idempotent under at-least-once delivery.
-- Domain event dispatch claims are introduced by the later migration.
ALTER TABLE "agentRun" ADD COLUMN "triggerEventId" TEXT;
CREATE UNIQUE INDEX "agentRun_triggerEventId_key" ON "agentRun"("triggerEventId");
