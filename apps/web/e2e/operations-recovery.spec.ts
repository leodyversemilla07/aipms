import { createHash, randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const createdEventIds: string[] = []
const createdRunIds: string[] = []
const createdMessageIds: string[] = []

test.afterAll(async () => {
  await db.domainEvent.deleteMany({ where: { id: { in: createdEventIds } } })
  await db.agentRun.deleteMany({ where: { id: { in: createdRunIds } } })
  await db.message.deleteMany({ where: { id: { in: createdMessageIds } } })
})

test("finance operator reviews and requeues a dead-lettered event", async ({
  page,
}) => {
  const marker = `e2e-recovery-${randomUUID()}`
  const event = await db.domainEvent.create({
    data: {
      type: marker,
      entityType: "RecoveryProbe",
      entityId: marker,
      payload: { internal: "not rendered in the recovery desk" },
      attemptCount: 5,
      lastError: "E2E subscriber unavailable",
      deadLetteredAt: new Date(),
      deadLetterReason: "exceeded delivery attempts in E2E",
    },
  })
  createdEventIds.push(event.id)

  await page.goto("/operations")
  await expect(
    page.getByRole("heading", { name: "Operations recovery" })
  ).toBeVisible()

  const row = page.getByRole("listitem").filter({ hasText: marker })
  await expect(row).toBeVisible()
  await expect(row).not.toContainText("not rendered in the recovery desk")
  await row.getByRole("button", { name: "Review and requeue" }).click()

  const dialog = page.getByRole("dialog", { name: "Requeue domain event" })
  await dialog
    .getByRole("textbox", { name: "Recovery evidence" })
    .fill("Repaired the E2E subscriber and verified its health check")
  await dialog
    .getByRole("button", { name: "Requeue event", exact: true })
    .click()

  await expect(dialog).toBeHidden()
  await expect(row).toBeHidden()

  await expect
    .poll(async () => {
      const stored = await db.domainEvent.findUnique({
        where: { id: event.id },
        select: { deadLetteredAt: true, attemptCount: true, publishedAt: true },
      })
      return {
        deadLettered: Boolean(stored?.deadLetteredAt),
        attempts: stored?.attemptCount,
        published: Boolean(stored?.publishedAt),
      }
    })
    .toEqual({ deadLettered: false, attempts: 0, published: true })

  const audit = await db.auditEntry.findFirstOrThrow({
    where: { action: "events.requeue", entityId: event.id },
    orderBy: { seq: "desc" },
  })
  expect(audit.after).toMatchObject({
    recoveryReason: "Repaired the E2E subscriber and verified its health check",
  })
})

test("finance operator retries only after provider-confirmed non-delivery", async ({
  page,
}) => {
  const vendor = await db.vendor.findFirstOrThrow({
    where: { status: "active" },
  })
  const marker = `E2E failed delivery ${randomUUID()}`
  const message = await db.message.create({
    data: {
      vendorId: vendor.id,
      recipient: "billing@acme.example",
      subject: marker,
      body: "Recovery probe",
      bodyHash: createHash("sha256").update("Recovery probe").digest("hex"),
      tier: "auto",
      status: "failed",
      failedReason: "E2E transport timeout after dispatch",
      dispatchStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    },
  })
  createdMessageIds.push(message.id)

  await page.goto("/operations")
  const row = page.getByRole("listitem").filter({ hasText: marker })
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: "Reconcile delivery" }).click()

  const dialog = page.getByRole("dialog", {
    name: "Reconcile message delivery",
  })
  await dialog.getByRole("button", { name: "Non-delivery confirmed" }).click()
  await dialog
    .getByRole("textbox", { name: "Provider evidence" })
    .fill("Provider case E2E-42 confirms its gateway never accepted delivery")
  await dialog.getByRole("button", { name: "Authorize one retry" }).click()

  await expect(dialog).toBeHidden()
  await expect(row).toBeHidden()
  const stored = (await db.message.findUniqueOrThrow({
    where: { id: message.id },
  })) as typeof message & {
    deliveryResolution: string | null
    deliveryResolutionEvidence: string | null
    deliveryResolvedBy: string | null
  }
  expect(stored).toMatchObject({
    status: "sent",
    deliveryResolution: "confirmed_not_sent",
    deliveryResolutionEvidence:
      "Provider case E2E-42 confirms its gateway never accepted delivery",
  })
  expect(stored.deliveryResolvedBy).not.toBeNull()
  const audit = await db.auditEntry.findFirstOrThrow({
    where: { action: "messaging.delivery.resolve", entityId: message.id },
    orderBy: { seq: "desc" },
  })
  expect(audit.inputHash).toBeTruthy()
})

test("finance operator closes a stale agent run without replaying it", async ({
  page,
}) => {
  const run = await db.agentRun.create({
    data: {
      agentId: `e2e-agent-${randomUUID()}`,
      status: "running",
      skills: ["intake"],
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  })
  createdRunIds.push(run.id)

  await page.goto("/operations")
  const row = page.getByRole("listitem").filter({ hasText: run.id })
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: "Review and cancel" }).click()

  const dialog = page.getByRole("dialog", { name: "Cancel stale agent run" })
  await dialog
    .getByRole("textbox", { name: "Recovery evidence" })
    .fill("Confirmed the worker lease expired and no process owns the run")
  await dialog.getByRole("button", { name: "Cancel stale run" }).click()

  await expect(dialog).toBeHidden()
  await expect(row).toBeHidden()
  const stored = await db.agentRun.findUniqueOrThrow({
    where: { id: run.id },
  })
  expect(stored.status).toBe("cancelled")
  expect(stored.finishedAt).not.toBeNull()
  const audit = await db.auditEntry.findFirstOrThrow({
    where: { action: "agent.stale.cancel", entityId: run.id },
    orderBy: { seq: "desc" },
  })
  expect(audit.after).toMatchObject({
    recoveryReason:
      "Confirmed the worker lease expired and no process owns the run",
  })
})
