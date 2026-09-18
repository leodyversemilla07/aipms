import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const createdEventIds: string[] = []
const createdRunIds: string[] = []

test.afterAll(async () => {
  await db.domainEvent.deleteMany({ where: { id: { in: createdEventIds } } })
  await db.agentRun.deleteMany({ where: { id: { in: createdRunIds } } })
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
