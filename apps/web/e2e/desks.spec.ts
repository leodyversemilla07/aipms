import { expect, test } from "@playwright/test"

/**
 * Desk smoke: every supervisory surface renders its core sections for an
 * authenticated finance user.
 */

test.describe("desks render", () => {
  test("supervisory desk shows stats, agent activity, and the exception queue", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Supervisory desk" })).toBeVisible()
    await expect(page.getByText("Agent activity")).toBeVisible()
    await expect(page.getByText("Exception queue")).toBeVisible()
    await expect(page.getByText("New requisition")).toBeVisible()
  })

  test("procurement desk shows sourcing, receipts, and messaging sections", async ({
    page,
  }) => {
    await page.goto("/procurement")
    await expect(page.getByText("Issue PO")).toBeVisible()
    await expect(page.getByText("Purchase orders")).toBeVisible()
    await expect(page.getByText("Goods receipts")).toBeVisible()
    await expect(page.getByText("Vendor messages")).toBeVisible()
  })

  test("finance desk shows invoices, payment runs, ERP sync, and BIR reports", async ({
    page,
  }) => {
    await page.goto("/finance")
    await expect(page.getByText("ERP sync (journal export §8.5)")).toBeVisible()
    await expect(
      page.getByText("BIR withholding (2307 / 1601-E)")
    ).toBeVisible()
    // Reconciliation gate always renders its summary line.
    await expect(page.getByText("executed runs:")).toBeVisible()
  })
})
