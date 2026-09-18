import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const createdEventIds: string[] = []

test.afterAll(async () => {
  await db.domainEvent.deleteMany({ where: { id: { in: createdEventIds } } })
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
