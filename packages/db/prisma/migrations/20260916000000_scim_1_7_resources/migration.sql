-- Better Auth SCIM 1.7 resource isolation and lifecycle state.
CREATE TABLE "scimConnectionBinding" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectionKey" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "decommissionedAt" TIMESTAMP(3),
    "decommissionStatus" TEXT NOT NULL DEFAULT 'active',
    "decommissionCursorUserId" TEXT,
    "decommissionReconciledUserCount" INTEGER NOT NULL DEFAULT 0,
    "decommissionBatchCount" INTEGER NOT NULL DEFAULT 0,
    "decommissionRevision" INTEGER NOT NULL DEFAULT 0,
    "decommissionCompletedAt" TIMESTAMP(3),
    "decommissionLeaseId" TEXT,
    "decommissionLeaseExpiresAt" TIMESTAMP(3),
    CONSTRAINT "scimConnectionBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimIdentityTombstone" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalIdKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimIdentityTombstone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimSubject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileSourceId" TEXT,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimSubject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimUser" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionUserKey" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userNameKey" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "workEmailValueIndex" TEXT NOT NULL,
    "emailValueIndex" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "formattedName" TEXT NOT NULL,
    "givenName" TEXT,
    "familyName" TEXT,
    "serializedEmails" TEXT NOT NULL,
    "serializedAttributes" TEXT,
    "externalId" TEXT,
    "externalIdKey" TEXT,
    "active" BOOLEAN NOT NULL,
    "orderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimProjectionGrant" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceValue" TEXT,
    "role" TEXT NOT NULL,
    "grantKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimProjectionGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimGroup" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "provisioningDomainId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "displayName" TEXT NOT NULL,
    "displayNameKey" TEXT NOT NULL,
    "externalId" TEXT,
    "externalIdKey" TEXT,
    "orderKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scimGroupMember" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "scimUserId" TEXT NOT NULL,
    "membershipKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "scimGroupMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scimConnectionBinding_connectionKey_key" ON "scimConnectionBinding"("connectionKey");
CREATE INDEX "scimConnectionBinding_connectionId_idx" ON "scimConnectionBinding"("connectionId");
CREATE UNIQUE INDEX "scimIdentityTombstone_externalIdKey_key" ON "scimIdentityTombstone"("externalIdKey");
CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON "scimIdentityTombstone"("connectionId");
CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON "scimIdentityTombstone"("provisioningDomainId");
CREATE INDEX "scimIdentityTombstone_userId_idx" ON "scimIdentityTombstone"("userId");
CREATE UNIQUE INDEX "scimSubject_userId_key" ON "scimSubject"("userId");
CREATE INDEX "scimSubject_profileSourceId_idx" ON "scimSubject"("profileSourceId");
CREATE UNIQUE INDEX "scimUser_connectionUserKey_key" ON "scimUser"("connectionUserKey");
CREATE UNIQUE INDEX "scimUser_userNameKey_key" ON "scimUser"("userNameKey");
CREATE UNIQUE INDEX "scimUser_externalIdKey_key" ON "scimUser"("externalIdKey");
CREATE UNIQUE INDEX "scimUser_orderKey_key" ON "scimUser"("orderKey");
CREATE INDEX "scimUser_connectionId_idx" ON "scimUser"("connectionId");
CREATE INDEX "scimUser_provisioningDomainId_idx" ON "scimUser"("provisioningDomainId");
CREATE INDEX "scimUser_userId_idx" ON "scimUser"("userId");
CREATE UNIQUE INDEX "scimProjectionGrant_grantKey_key" ON "scimProjectionGrant"("grantKey");
CREATE INDEX "scimProjectionGrant_connectionId_idx" ON "scimProjectionGrant"("connectionId");
CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON "scimProjectionGrant"("provisioningDomainId");
CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON "scimProjectionGrant"("scimUserId");
CREATE INDEX "scimProjectionGrant_userId_idx" ON "scimProjectionGrant"("userId");
CREATE UNIQUE INDEX "scimGroup_displayNameKey_key" ON "scimGroup"("displayNameKey");
CREATE UNIQUE INDEX "scimGroup_externalIdKey_key" ON "scimGroup"("externalIdKey");
CREATE UNIQUE INDEX "scimGroup_orderKey_key" ON "scimGroup"("orderKey");
CREATE INDEX "scimGroup_connectionId_idx" ON "scimGroup"("connectionId");
CREATE INDEX "scimGroup_provisioningDomainId_idx" ON "scimGroup"("provisioningDomainId");
CREATE UNIQUE INDEX "scimGroupMember_membershipKey_key" ON "scimGroupMember"("membershipKey");
CREATE INDEX "scimGroupMember_connectionId_idx" ON "scimGroupMember"("connectionId");
CREATE INDEX "scimGroupMember_groupId_idx" ON "scimGroupMember"("groupId");
CREATE INDEX "scimGroupMember_scimUserId_idx" ON "scimGroupMember"("scimUserId");

ALTER TABLE "scimIdentityTombstone" ADD CONSTRAINT "scimIdentityTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimSubject" ADD CONSTRAINT "scimSubject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimUser" ADD CONSTRAINT "scimUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimProjectionGrant" ADD CONSTRAINT "scimProjectionGrant_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "scimUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimProjectionGrant" ADD CONSTRAINT "scimProjectionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimGroupMember" ADD CONSTRAINT "scimGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "scimGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scimGroupMember" ADD CONSTRAINT "scimGroupMember_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "scimUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
