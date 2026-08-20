-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('running', 'succeeded', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "runId" TEXT;

-- CreateTable
CREATE TABLE "agentRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'running',
    "skills" TEXT[],
    "meta" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "agentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domainEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agentRun_agentId_idx" ON "agentRun"("agentId");

-- CreateIndex
CREATE INDEX "agentRun_status_idx" ON "agentRun"("status");

-- CreateIndex
CREATE INDEX "agentRun_startedAt_idx" ON "agentRun"("startedAt");

-- CreateIndex
CREATE INDEX "domainEvent_publishedAt_idx" ON "domainEvent"("publishedAt");

-- CreateIndex
CREATE INDEX "domainEvent_type_idx" ON "domainEvent"("type");

-- CreateIndex
CREATE INDEX "domainEvent_createdAt_idx" ON "domainEvent"("createdAt");
