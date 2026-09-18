import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const vendorIds: string[] = []

test.afterAll(async () => {
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
})

test("beneficiary account requires a different finance checker", async ({
  browser,
  page,
}) => {
  const suffix = randomUUID().slice(0, 8)
  const vendorName = `E2E dual control ${suffix}`
  const accountNumber = `9900${Date.now()}`

  // Procurement owns vendor creation; seed the supplier so this finance
  // scenario exercises only the beneficiary dual-control boundary.
  const vendor = await db.vendor.create({
    data: {
      name: vendorName,
      email: `dual-${suffix}@example.test`,
      status: "qualified",
    },
  })
  vendorIds.push(vendor.id)

  await page.goto("/master-data")
  const makerRow = page.getByRole("listitem").filter({ hasText: vendorName })
  await expect(makerRow).toBeVisible()

  await makerRow.getByRole("button", { name: "Add bank" }).click()
  await makerRow.getByLabel("Bank").fill("E2E Bank")
  await makerRow.getByLabel("Account number").fill(accountNumber)
  await makerRow.getByLabel("Holder").fill(vendorName)
  await makerRow.getByRole("button", { name: "Submit account" }).click()
  await expect(
    page.getByText(/Beneficiary account submitted; a different finance user/)
  ).toBeVisible()
  await expect(makerRow.getByText("bank pending checker")).toBeVisible()

  // The maker cannot approve their own beneficiary change, even with the
  // independently re-entered matching details.
  await makerRow.getByRole("button", { name: "Check bank" }).click()
  await makerRow.getByLabel("Bank").fill("E2E Bank")
  await makerRow.getByLabel("Account number").fill(accountNumber)
  await makerRow.getByLabel("Holder").fill(vendorName)
  await makerRow
    .getByRole("button", { name: "Verify matching account" })
    .click()
  await expect(
    page.getByText(/requires a different finance user/i)
  ).toBeVisible()

  const checkerContext = await browser.newContext()
  try {
    const checkerPage = await checkerContext.newPage()
    const signIn = await checkerPage.request.post(
      "http://localhost:3000/api/auth/sign-in/email",
      {
        data: {
          email: "checker@demo.aipms",
          password: "demo-checker-123",
        },
      }
    )
    expect(signIn.ok()).toBeTruthy()

    await checkerPage.goto("/master-data")
    const checkerRow = checkerPage
      .getByRole("listitem")
      .filter({ hasText: vendorName })
    await expect(checkerRow.getByText("bank pending checker")).toBeVisible()
    await checkerRow.getByRole("button", { name: "Check bank" }).click()
    await checkerRow.getByLabel("Bank").fill("E2E Bank")
    await checkerRow.getByLabel("Account number").fill(accountNumber)
    await checkerRow.getByLabel("Holder").fill(vendorName)
    await checkerRow
      .getByRole("button", { name: "Verify matching account" })
      .click()

    await expect(
      checkerPage.getByText(
        "Beneficiary bank account verified by the second finance user"
      )
    ).toBeVisible()
    await expect(checkerRow.getByText("bank ✓")).toBeVisible()
  } finally {
    await checkerContext.close()
  }

  const verified = await db.vendor.findUniqueOrThrow({
    where: { id: vendor.id },
  })
  expect(verified.bankAccountVerifiedAt).not.toBeNull()
  expect(verified.bankAccountChangedAt).toBeNull()
  expect(verified.bankAccountSubmittedBy).not.toBe(
    verified.bankAccountVerifiedBy
  )
})
