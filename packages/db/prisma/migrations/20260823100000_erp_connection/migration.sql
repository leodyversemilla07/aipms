-- §8.5 QuickBooks Online connector: OAuth connection storage.

-- CreateTable
CREATE TABLE "erpConnection" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erpConnection_provider_realmId_key" ON "erpConnection"("provider", "realmId");
