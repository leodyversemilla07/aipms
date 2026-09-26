-- Durable relay leases prevent multiple API replicas from dispatching the
-- same outbox event concurrently. Claims are recoverable after their lease
-- expires, so a process crash cannot strand an event permanently.
ALTER TABLE "domainEvent"
  ADD COLUMN "dispatchClaimId" TEXT,
  ADD COLUMN "dispatchClaimedAt" TIMESTAMP(3);

CREATE INDEX "domainEvent_dispatchClaimedAt_idx"
  ON "domainEvent"("dispatchClaimedAt");
