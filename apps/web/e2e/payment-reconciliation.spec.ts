import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const runIds: string[] = []
const invoiceIds: string[] = []
const vendorIds: string[] = []

test.afterAll(async () => {
  await db.paymentRun.deleteMany({ where: { id: { in: runIds } } })
  await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
})

test("finance reconciles paid and dishonored payment lines", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const maker = await db.user.findUniqueOrThrow({
    where: { email: "maker@demo.aipms" },
  })
  const checker = await db.user.findUniqueOrThrow({
    where: { email: "checker@demo.aipms" },
  })
  const vendor = await db.vendor.create({
    data: { name: `E2E reconciliation ${suffix}`, status: "active" },
  })
  vendorIds.push(vendor.id)

  const paidInvoice = await db.invoice.create({
    data: {
      vendorId: vendor.id,
      number: `E2E-PAID-${suffix}`,
      amountMinor: 100_000,
      vatMinor: 12_000,
      ewtMinor: 1_000,
      status: "matched",
    },
  })
  const dishonoredInvoice = await db.invoice.create({
    data: {
      vendorId: vendor.id,
      number: `E2E-DISHONORED-${suffix}`,
      amountMinor: 50_000,
      vatMinor: 6_000,
      ewtMinor: 500,
      status: "matched",
    },
  })
  invoiceIds.push(paidInvoice.id, dishonoredInvoice.id)

  const runNumber = `RUN-E2E-${suffix}`
  const run = await db.paymentRun.create({
    data: {
      runNumber,
      status: "executed",
      totalMinor: 166_500,
      createdBy: maker.id,
      approvedBy: checker.id,
      approvedAt: new Date(),
      executedBy: checker.id,
      executedAt: new Date(),
      lines: {
        create: [
          {
            invoiceId: paidInvoice.id,
            netMinor: 111_000,
            status: "planned",
          },
          {
            invoiceId: dishonoredInvoice.id,
            netMinor: 55_500,
            status: "planned",
          },
        ],
      },
    },
    include: { lines: true },
  })
  runIds.push(run.id)

  await page.goto("/finance")
  const runRow = page.getByRole("listitem").filter({ hasText: runNumber })
  await expect(runRow).toBeVisible()
  await expect(runRow.getByText("Executed", { exact: true })).toBeVisible()

  const paidLine = runRow
    .getByRole("listitem")
    .filter({ hasText: paidInvoice.id.slice(0, 8) })
  const dishonoredLine = runRow
    .getByRole("listitem")
    .filter({ hasText: dishonoredInvoice.id.slice(0, 8) })

  await paidLine.getByRole("button", { name: "Paid", exact: true }).click()
  await expect(paidLine.getByText("Paid", { exact: true })).toBeVisible()
  await expect(runRow.getByText("Executed", { exact: true })).toBeVisible()

  await dishonoredLine
    .getByRole("button", { name: "Dishonored", exact: true })
    .click()
  await expect(
    dishonoredLine.getByText("Dishonored", { exact: true })
  ).toBeVisible()
  await expect(runRow.getByText("Reconciled", { exact: true })).toBeVisible()

  const [storedRun, storedPaid, storedDishonored] = await Promise.all([
    db.paymentRun.findUniqueOrThrow({ where: { id: run.id } }),
    db.invoice.findUniqueOrThrow({ where: { id: paidInvoice.id } }),
    db.invoice.findUniqueOrThrow({ where: { id: dishonoredInvoice.id } }),
  ])
  expect(storedRun.status).toBe("reconciled")
  expect(storedRun.reconciledAt).not.toBeNull()
  expect(storedPaid.status).toBe("paid")
  expect(storedDishonored.status).toBe("matched")

  const audits = await db.auditEntry.findMany({
    where: {
      actorId: maker.id,
      action: "paymentRun.reconcile",
      entityId: { in: run.lines.map((line) => line.id) },
    },
  })
  expect(audits).toHaveLength(2)
})
