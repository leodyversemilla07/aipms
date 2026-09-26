import { expect, test } from "@playwright/test"

const email = process.env.STAGING_WORKLOAD_EMAIL
const password = process.env.STAGING_WORKLOAD_PASSWORD
const journeyCount = Number.parseInt(
  process.env.STAGING_WORKLOAD_JOURNEYS ?? "20",
  10
)
const routes = (
  process.env.STAGING_WORKLOAD_ROUTES ??
  "/,/procurement,/intake,/finance,/operations"
)
  .split(",")
  .map((route) => route.trim())
  .filter(Boolean)

if (!email || !password) {
  throw new Error(
    "STAGING_WORKLOAD_EMAIL and STAGING_WORKLOAD_PASSWORD are required"
  )
}
if (!Number.isInteger(journeyCount) || journeyCount < 1 || journeyCount > 500) {
  throw new Error("STAGING_WORKLOAD_JOURNEYS must be between 1 and 500")
}
if (routes.length === 0 || routes.some((route) => !route.startsWith("/"))) {
  throw new Error("STAGING_WORKLOAD_ROUTES must contain absolute app paths")
}

test.use({ storageState: { cookies: [], origins: [] } })

for (let index = 0; index < journeyCount; index += 1) {
  test(`read-only staging browser journey ${index + 1}`, async ({ page }) => {
    await page.goto("/")
    await page.getByLabel("Email", { exact: true }).fill(email)
    await page.getByLabel("Password", { exact: true }).fill(password)
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Supervisory desk" })
    ).toBeVisible()

    for (const route of routes) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" })
      expect(
        response,
        `${route} did not return an HTTP response`
      ).not.toBeNull()
      expect(response?.status(), `${route} returned an error`).toBeLessThan(400)
      expect(new URL(page.url()).pathname).toBe(route)
      await expect(page.locator("body")).not.toContainText(/application error/i)
    }
  })
}
