import { expect, test } from "@playwright/test"

test("sidebar persists across desks and marks the current page", async ({
  page,
}) => {
  await page.goto("/")
  const toolbar = page.locator('[data-slot="sidebar-inset"] > header')
  const breadcrumb = toolbar.getByRole("navigation", { name: "Breadcrumb" })
  await expect(breadcrumb.getByRole("link", { name: "AIPMS" })).toBeVisible()
  await expect(
    breadcrumb.getByText("Dashboard", { exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(toolbar.getByRole("heading")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Supervisory desk" })
  ).toBeVisible()
  // The page title sits on the content edge, and every page keeps that edge.
  const dashboardTitle = await page
    .getByRole("heading", { name: "Supervisory desk" })
    .boundingBox()
  const contentColumn = page
    .locator('[data-slot="sidebar-inset"] > div')
    .first()
  const dashboardColumn = await contentColumn.boundingBox()
  expect(dashboardColumn).not.toBeNull()
  const nav = page.getByRole("navigation", { name: "Desks" })
  await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
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
  const financeTitle = await page
    .getByRole("heading", { name: "Finance desk" })
    .boundingBox()
  expect(financeTitle?.x).toBeCloseTo(dashboardTitle?.x ?? 0, 0)
  await nav.getByRole("link", { name: "Procurement" }).click()
  await expect(
    page.getByRole("heading", { name: "Procurement desk" })
  ).toBeVisible()
  const procurementTitle = await page
    .getByRole("heading", { name: "Procurement desk" })
    .boundingBox()
  expect(procurementTitle?.x).toBeCloseTo(dashboardTitle?.x ?? 0, 0)
  // The header trigger collapses and reopens the rail (off-canvas, like
  // sidebar-08), while the desk list itself stays flat.
  const trigger = page.getByRole("button", { name: "Toggle Sidebar" })
  const sidebar = page.locator('[data-slot="sidebar"]').first()
  await expect(trigger).toBeVisible()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await trigger.click()
  await expect(sidebar).toHaveAttribute("data-state", "collapsed")
  await trigger.click()
  await expect(sidebar).toHaveAttribute("data-state", "expanded")
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible()
  await page.getByRole("button", { name: /Demo Maker/ }).click()
  await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible()
})

test("mobile sidebar opens and closes after navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  const contentColumn = page
    .locator('[data-slot="sidebar-inset"] > div')
    .first()
  await expect(contentColumn).toBeVisible()
  const dashboardTitle = await page
    .getByRole("heading", { name: "Supervisory desk" })
    .boundingBox()
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const nav = page.getByRole("navigation", { name: "Desks" })
  await expect(nav.getByRole("link", { name: "Intake" })).toBeVisible()
  await nav.getByRole("link", { name: "Intake" }).click()
  await expect(page.getByRole("heading", { name: "Intake desk" })).toBeVisible()
  await expect(nav).not.toBeVisible()
  const intakeTitle = await page
    .getByRole("heading", { name: "Intake desk" })
    .boundingBox()
  expect(intakeTitle?.x).toBeCloseTo(dashboardTitle?.x ?? 0, 0)
})
