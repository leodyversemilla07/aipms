CREATE TABLE "qboOAuthState" (
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qboOAuthState_pkey" PRIMARY KEY ("stateHash")
);

CREATE INDEX "qboOAuthState_expiresAt_idx" ON "qboOAuthState"("expiresAt");
