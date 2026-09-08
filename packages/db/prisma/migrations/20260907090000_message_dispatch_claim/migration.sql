-- Claim outbound delivery before contacting the external transport. This
-- prevents concurrent workers from both sending the same message. A worker
-- crash leaves an explicit `sending` row for operator reconciliation instead
-- of making an unsafe automatic retry.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'sending' AFTER 'approved';
ALTER TABLE "message" ADD COLUMN "dispatchStartedAt" TIMESTAMP(3);
