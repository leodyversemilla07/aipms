-- CreateTable
CREATE TABLE "poSignature" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "signerId" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poSignature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "poSignature_poId_idx" ON "poSignature"("poId");

-- AddForeignKey
ALTER TABLE "poSignature" ADD CONSTRAINT "poSignature_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
