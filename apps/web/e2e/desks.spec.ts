import { expect, test } from "@playwright/test"

/**
 * Desk smoke: every supervisory surface renders its core sections for an
 * authenticated finance user.
 */

test.describe("desks render", () => {
  test("dashboard summarises decisions, flow health, and requisitions", async ({
    page,
  }) => {
    await page.goto("/")
    await expect(
      page.getByRole("heading", { name: "Supervisory desk" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Flow health" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Awaiting decision" })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "New requisition" })
    ).toBeVisible()
  })

  test("queue pages own their content", async ({ page }) => {
    await page.goto("/approvals")
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible()
    await page.goto("/exceptions")
    await expect(
      page.getByRole("heading", { name: "Invoice exceptions" })
    ).toBeVisible()
    await page.goto("/agent-runs")
    await expect(
      page.getByRole("heading", { name: "Agent runs" })
    ).toBeVisible()
  })

  test("procurement desk shows sourcing, receipts, and messaging sections", async ({
    page,
  }) => {
    await page.goto("/procurement")
    // The sidebar repeats the section names as sub-navigation, so the
    // assertions are scoped to the desk content.
    const desk = page.locator('[data-slot="sidebar-inset"]')
    await expect(desk.getByText("Issue PO")).toBeVisible()
    await expect(desk.getByText("Purchase orders")).toBeVisible()
    await expect(desk.getByText("Goods receipts")).toBeVisible()
    await expect(desk.getByText("Vendor messages")).toBeVisible()
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
    const invoices = page
      .getByRole("heading", { name: "Invoices", exact: true })
      .locator("../..")
    await expect(
      invoices
        .getByRole("table")
        .or(invoices.getByText("No invoices registered yet."))
    ).toBeVisible()
  })
})
