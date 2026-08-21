-- CreateTable
CREATE TABLE "ssoProvider" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "oidcConfig" TEXT,
    "samlConfig" TEXT,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "organizationId" TEXT,
    "domain" TEXT NOT NULL,

    CONSTRAINT "ssoProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scimProvider" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "scimToken" TEXT NOT NULL,
    "organizationId" TEXT,

    CONSTRAINT "scimProvider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ssoProvider_providerId_key" ON "ssoProvider"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "scimProvider_providerId_key" ON "scimProvider"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "scimProvider_scimToken_key" ON "scimProvider"("scimToken");
