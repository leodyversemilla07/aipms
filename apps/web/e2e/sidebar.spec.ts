import { expect, test } from "@playwright/test"

test("sidebar persists across desks and marks the current page", async ({
  page,
}) => {
  await page.goto("/")
  const toolbar = page.locator('[data-slot="sidebar-inset"] > header')
  const breadcrumb = toolbar.getByRole("navigation", { name: "Breadcrumb" })
  await expect(breadcrumb.getByRole("link", { name: "AIPMS" })).toBeVisible()
  await expect(
    breadcrumb.getByText("Overview", { exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(toolbar.getByRole("heading")).toHaveCount(0)
  await expect(
    page
      .locator('[data-slot="card"]')
      .getByRole("heading", { name: "Supervisory desk" })
  ).toBeVisible()
  const pageHeader = page
    .locator('[data-slot="sidebar-inset"] [data-slot="card"]')
    .first()
  const overviewBounds = await pageHeader.boundingBox()
  expect(overviewBounds).not.toBeNull()
  const nav = page.getByRole("navigation", { name: "Desks" })
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await nav.getByRole("link", { name: "Finance" }).click()
  await expect(
    page.getByRole("heading", { name: "Finance desk" })
  ).toBeVisible()
  await expect(
    breadcrumb.getByText("Finance", { exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(nav.getByRole("link", { name: "Finance" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  const financeBounds = await pageHeader.boundingBox()
  expect(financeBounds?.x).toBeCloseTo(overviewBounds?.x ?? 0, 0)
  expect(financeBounds?.width).toBeCloseTo(overviewBounds?.width ?? 0, 0)
  await nav.getByRole("link", { name: "Procurement" }).click()
  await expect(
    page.getByRole("heading", { name: "Procurement desk" })
  ).toBeVisible()
  const procurementBounds = await pageHeader.boundingBox()
  expect(procurementBounds?.x).toBeCloseTo(overviewBounds?.x ?? 0, 0)
  expect(procurementBounds?.width).toBeCloseTo(overviewBounds?.width ?? 0, 0)
  await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  await expect(nav.getByRole("link", { name: "Overview" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
})

test("mobile sidebar opens and closes after navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const pageHeader = page
    .locator('[data-slot="sidebar-inset"] [data-slot="card"]')
    .first()
  await expect(pageHeader).toBeVisible()
  const overviewBounds = await pageHeader.boundingBox()
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const nav = page.getByRole("navigation", { name: "Desks" })
  await expect(nav.getByRole("link", { name: "Intake" })).toBeVisible()
  await nav.getByRole("link", { name: "Intake" }).click()
  await expect(page.getByRole("heading", { name: "Intake desk" })).toBeVisible()
  await expect(nav).not.toBeVisible()
  const intakeBounds = await pageHeader.boundingBox()
  expect(intakeBounds?.x).toBeCloseTo(overviewBounds?.x ?? 0, 0)
  expect(intakeBounds?.width).toBeCloseTo(overviewBounds?.width ?? 0, 0)
})
