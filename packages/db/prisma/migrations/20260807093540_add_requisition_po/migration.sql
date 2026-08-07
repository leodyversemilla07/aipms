-- CreateEnum
CREATE TYPE "ReqStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'exception', 'cancelled');

-- CreateEnum
CREATE TYPE "ReqLineStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('draft', 'issued', 'confirmed', 'cancelled');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'overridden');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('threshold', 'budgetOverride', 'vendorGate', 'policyGate', 'poCancellation');

-- CreateTable
CREATE TABLE "requisition" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "ReqStatus" NOT NULL DEFAULT 'draft',
    "costCenter" TEXT NOT NULL,
    "budgetId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "note" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisitionLine" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "unitPriceMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "lineTotalMinor" INTEGER NOT NULL,
    "status" "ReqLineStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "requisitionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchaseOrder" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "requisitionId" TEXT,
    "vendorId" TEXT NOT NULL,
    "status" "PoStatus" NOT NULL DEFAULT 'draft',
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "totalMinor" INTEGER NOT NULL,
    "terms" JSONB,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchaseOrderLine" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "sku" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'ea',
    "unitPriceMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "lineTotalMinor" INTEGER NOT NULL,

    CONSTRAINT "purchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" TEXT NOT NULL,
    "requisitionId" TEXT,
    "poId" TEXT,
    "kind" "ApprovalKind" NOT NULL,
    "gateOutcome" TEXT NOT NULL DEFAULT 'NEED_APPROVAL',
    "route" JSONB NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "requisition_requestNumber_key" ON "requisition"("requestNumber");

-- CreateIndex
CREATE INDEX "requisition_status_idx" ON "requisition"("status");

-- CreateIndex
CREATE INDEX "requisition_costCenter_idx" ON "requisition"("costCenter");

-- CreateIndex
CREATE INDEX "requisition_requestedBy_idx" ON "requisition"("requestedBy");

-- CreateIndex
CREATE INDEX "requisitionLine_requisitionId_idx" ON "requisitionLine"("requisitionId");

-- CreateIndex
CREATE UNIQUE INDEX "purchaseOrder_poNumber_key" ON "purchaseOrder"("poNumber");

-- CreateIndex
CREATE INDEX "purchaseOrder_status_idx" ON "purchaseOrder"("status");

-- CreateIndex
CREATE INDEX "purchaseOrder_vendorId_idx" ON "purchaseOrder"("vendorId");

-- CreateIndex
CREATE INDEX "purchaseOrderLine_poId_idx" ON "purchaseOrderLine"("poId");

-- CreateIndex
CREATE INDEX "approval_requisitionId_idx" ON "approval"("requisitionId");

-- CreateIndex
CREATE INDEX "approval_poId_idx" ON "approval"("poId");

-- CreateIndex
CREATE INDEX "approval_status_idx" ON "approval"("status");

-- AddForeignKey
ALTER TABLE "requisitionLine" ADD CONSTRAINT "requisitionLine_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchaseOrderLine" ADD CONSTRAINT "purchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_requisitionId_fkey" FOREIGN KEY ("requisitionId") REFERENCES "requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
