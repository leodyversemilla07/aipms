import { createHash, randomBytes, randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const CORE_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
const providerIds: string[] = []
const provisionedEmails: string[] = []

test.afterAll(async () => {
  const users = await db.user.findMany({
    where: { email: { in: provisionedEmails } },
    select: { id: true },
  })
  await db.user.deleteMany({
    where: { id: { in: users.map((user) => user.id) } },
  })
  await db.scimConnectionBinding.deleteMany({
    where: { connectionId: { in: providerIds } },
  })
  await db.scimProvider.deleteMany({
    where: { providerId: { in: providerIds } },
  })
  await db.ssoProvider.deleteMany({
    where: { providerId: { in: providerIds } },
  })
})

test("SCIM bearer provisions and deprovisions an isolated user", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 10)
  const providerId = `e2e-scim-${suffix}`
  const email = `${providerId}@example.test`
  const token = `aipms_scim_${randomBytes(32).toString("base64url")}`
  const digest = createHash("sha256").update(token).digest("base64url")
  providerIds.push(providerId)
  provisionedEmails.push(email)

  const admin = await db.user.findUniqueOrThrow({
    where: { email: "checker@demo.aipms" },
  })
  await db.ssoProvider.create({
    data: {
      id: randomUUID(),
      issuer: `https://${providerId}.example.test`,
      domain: "example.test",
      userId: admin.id,
      providerId,
    },
  })
  await db.scimProvider.create({
    data: {
      id: randomUUID(),
      providerId,
      scimToken: `sha256:${digest}:${token.slice(-4)}`,
    },
  })

  const endpoint = "/api/auth/scim/v2/Users"
  const unauthorized = await page.request.get(endpoint, {
    headers: { Authorization: "Bearer invalid-e2e-token" },
  })
  expect(unauthorized.status()).toBe(401)

  const createdResponse = await page.request.post(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/scim+json",
    },
    data: {
      schemas: [CORE_USER],
      externalId: `external-${suffix}`,
      userName: email,
      displayName: `SCIM E2E ${suffix}`,
      name: { givenName: "SCIM", familyName: "E2E" },
      emails: [{ value: email, primary: true, type: "work" }],
      active: true,
    },
  })
  const created = (await createdResponse.json()) as {
    detail?: string
    id: string
    userName: string
    active: boolean
  }
  expect(
    createdResponse.ok(),
    `SCIM create failed: ${JSON.stringify(created)}`
  ).toBeTruthy()
  expect(created).toMatchObject({ userName: email, active: true })

  const provisioned = await db.user.findUniqueOrThrow({ where: { email } })
  expect(provisioned).toMatchObject({ kind: "human", role: "user" })
  const source = await db.scimUser.findUniqueOrThrow({
    where: { id: created.id },
  })
  expect(source).toMatchObject({
    userId: provisioned.id,
    connectionId: providerId,
    provisioningDomainId: providerId,
    active: true,
  })

  const deactivatedResponse = await page.request.patch(
    `${endpoint}/${encodeURIComponent(created.id)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/scim+json",
      },
      data: {
        schemas: [PATCH_OP],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    }
  )
  const deactivatedBody = (await deactivatedResponse.json()) as {
    active?: boolean
    detail?: string
  }
  expect(
    deactivatedResponse.ok(),
    `SCIM deprovision failed: ${JSON.stringify(deactivatedBody)}`
  ).toBeTruthy()
  expect(deactivatedBody).toMatchObject({ active: false })

  const deactivated = await db.scimUser.findUniqueOrThrow({
    where: { id: created.id },
  })
  expect(deactivated.active).toBe(false)
  expect(await db.session.count({ where: { userId: provisioned.id } })).toBe(0)
})
