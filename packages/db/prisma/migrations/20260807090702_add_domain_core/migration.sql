-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('human', 'agent');

-- CreateEnum
CREATE TYPE "AwardCriterion" AS ENUM ('lcrb', 'mearb', 'marb', 'hrrb', 'lowestCost', 'bestValue');

-- CreateEnum
CREATE TYPE "EntityClass" AS ENUM ('catalog', 'negotiated', 'competitive');

-- CreateEnum
CREATE TYPE "PublicationState" AS ENUM ('sealed', 'published', 'redacted');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('prospective', 'active', 'watch', 'blacklisted');

-- CreateEnum
CREATE TYPE "PolicyKind" AS ENUM ('threshold', 'preferredVendor', 'approvalChain', 'budgetControl', 'evaluationCriterion');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "kind" "UserKind" NOT NULL DEFAULT 'human',
ADD COLUMN     "quotas" JSONB,
ADD COLUMN     "scopes" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "catalogItem" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultPriceMinor" INTEGER,
    "defaultCurrencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "qualifiedVendorIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "VendorStatus" NOT NULL DEFAULT 'prospective',
    "email" TEXT,
    "taxId" TEXT,
    "paymentTermsDays" INTEGER,
    "ratingScore" INTEGER,
    "qualifiedEntityClass" "EntityClass",
    "blacklistReason" TEXT,
    "contactChannels" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "costCenter" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "limitMinor" INTEGER NOT NULL DEFAULT 0,
    "committedMinor" INTEGER NOT NULL DEFAULT 0,
    "spentMinor" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PolicyKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "config" JSONB NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorKind" "UserKind" NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "inputHash" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotencyKey" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalogItem_sku_key" ON "catalogItem"("sku");

-- CreateIndex
CREATE INDEX "catalogItem_category_idx" ON "catalogItem"("category");

-- CreateIndex
CREATE INDEX "catalogItem_active_idx" ON "catalogItem"("active");

-- CreateIndex
CREATE INDEX "vendor_status_idx" ON "vendor"("status");

-- CreateIndex
CREATE INDEX "vendor_name_idx" ON "vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "budget_costCenter_period_key" ON "budget"("costCenter", "period");

-- CreateIndex
CREATE INDEX "policy_kind_enabled_idx" ON "policy"("kind", "enabled");

-- CreateIndex
CREATE INDEX "AuditEntry_entity_entityId_idx" ON "AuditEntry"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditEntry_actorId_idx" ON "AuditEntry"("actorId");

-- CreateIndex
CREATE INDEX "AuditEntry_at_idx" ON "AuditEntry"("at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotencyKey_key_key" ON "idempotencyKey"("key");

-- CreateIndex
CREATE INDEX "idempotencyKey_key_idx" ON "idempotencyKey"("key");
