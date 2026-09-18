import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const exportIds: string[] = []
const runIds: string[] = []

test.afterAll(async () => {
  await db.erpJournalExport.deleteMany({ where: { id: { in: exportIds } } })
  await db.domainEvent.deleteMany({
    where: { entityType: "PaymentRun", entityId: { in: runIds } },
  })
})

test("ambiguous QBO dispatch requires an independent resolver", async ({
  browser,
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const maker = await db.user.findUniqueOrThrow({
    where: { email: "maker@demo.aipms" },
  })
  const checker = await db.user.findUniqueOrThrow({
    where: { email: "checker@demo.aipms" },
  })
  const runId = `qbo-e2e-run-${suffix}`
  const runNumber = `RUN-QBO-E2E-${suffix}`
  const externalRef = `QB-E2E-${suffix}`
  runIds.push(runId)

  const exported = await db.erpJournalExport.create({
    data: {
      runId,
      runNumber,
      manifestHash: "a".repeat(64),
      manifestJson: JSON.stringify({ runNumber, entries: [] }),
      lineCount: 1,
      totalMinor: 125_000,
      status: "exported",
      dispatchClaimId: randomUUID(),
      dispatchClaimedBy: maker.id,
      dispatchStartedAt: new Date(),
      dispatchFailure: "connection reset after the provider accepted the POST",
      exportedBy: maker.id,
    },
  })
  exportIds.push(exported.id)

  await page.goto("/finance")
  const makerRow = page.getByRole("listitem").filter({ hasText: runNumber })
  await expect(makerRow).toContainText(
    "QBO outcome requires review by a different finance user"
  )
  page.once("dialog", (dialog) => dialog.accept(externalRef))
  await makerRow.getByRole("button", { name: "Resolve posted" }).click()
  await expect(
    page.getByText(/maker and manual-resolution checker must differ/i)
  ).toBeVisible()

  const unresolved = await db.erpJournalExport.findUniqueOrThrow({
    where: { id: exported.id },
  })
  expect(unresolved.status).toBe("exported")
  expect(unresolved.dispatchResolvedBy).toBeNull()

  const checkerContext = await browser.newContext({
    baseURL: "http://localhost:3000",
    storageState: "e2e/.auth/checker.json",
  })
  try {
    const checkerPage = await checkerContext.newPage()
    await checkerPage.goto("/finance")
    const checkerRow = checkerPage
      .getByRole("listitem")
      .filter({ hasText: runNumber })
    await expect(checkerRow).toContainText(
      "QBO outcome requires review by a different finance user"
    )
    checkerPage.once("dialog", (dialog) => dialog.accept(externalRef))
    await checkerRow.getByRole("button", { name: "Resolve posted" }).click()
    await expect(checkerRow.getByText("posted", { exact: true })).toBeVisible()
    await expect(checkerRow).toContainText(`ref ${externalRef}`)
  } finally {
    await checkerContext.close()
  }

  const resolved = await db.erpJournalExport.findUniqueOrThrow({
    where: { id: exported.id },
  })
  expect(resolved).toMatchObject({
    status: "posted",
    externalRef,
    dispatchResolvedBy: checker.id,
  })
  expect(resolved.dispatchResolvedAt).not.toBeNull()
  expect(resolved.dispatchResolvedBy).not.toBe(resolved.dispatchClaimedBy)
  const audit = await db.auditEntry.findFirstOrThrow({
    where: {
      actorId: checker.id,
      action: "erp.qbo.resolveDispatch",
      entityId: exported.id,
    },
    orderBy: { seq: "desc" },
  })
  expect(audit.after).toMatchObject({ externalRef })
})
