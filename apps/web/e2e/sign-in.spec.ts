import { expect, test } from "@playwright/test"

test.use({ storageState: { cookies: [], origins: [] } })

test("sign-in supports provisioned users without exposing public enrollment", async ({
  page,
}) => {
  const buttonSemanticsErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("nativeButton")) {
      buttonSemanticsErrors.push(message.text())
    }
  })
  await page.goto("/")
  await expect(page.getByText("Need access?")).toBeVisible()
  await expect(
    page.getByRole("button", { name: /Create account/ })
  ).toHaveCount(0)
  await expect(page.getByText("No account? Create one")).toHaveCount(0)
  const signup = await page.request.post("/api/auth/sign-up/email", {
    data: {
      name: "Uninvited",
      email: `uninvited-${Date.now()}@test.aipms`,
      password: "uninvited-test-password",
    },
  })
  expect(signup.status()).toBe(404)

  await page.getByLabel("Email", { exact: true }).fill("maker@demo.aipms")
  await page.getByLabel("Password", { exact: true }).fill("demo-maker-123")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Supervisory desk" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Awaiting decision" })
  ).toBeVisible()
  await expect(page.getByRole("heading", { name: "Flow health" })).toBeVisible()
  await expect(page.getByText("Budget watch", { exact: true })).toBeVisible()
  await expect(
    page.locator('[data-slot="sidebar-inset"]').getByText("Invoice exceptions")
  ).toBeVisible()
  await expect(page.getByRole("link", { name: "Procurement" })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Open exceptions" })
  ).toBeVisible()
  expect(buttonSemanticsErrors).toEqual([])
})

test("a background session check keeps the typed email", async ({ page }) => {
  await page.goto("/login")
  const email = page.getByLabel("Email", { exact: true })
  await expect(email).toBeVisible()
  await email.fill("maker@demo.aipms")

  // Returning to the tab makes better-auth re-check the session. Hold the
  // response so the in-flight state stays observable instead of racing it.
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route("**/api/auth/get-session", async (route) => {
    await responseGate
    await route.continue()
  })

  const refetch = page.waitForRequest("**/api/auth/get-session")
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await refetch

  // The form must stay mounted with its value while the check is in flight,
  // and keep it once the answer lands.
  await expect(email).toHaveValue("maker@demo.aipms")
  releaseResponse()
  await expect(email).toHaveValue("maker@demo.aipms")
  await expect(page.getByText("Checking your session")).toHaveCount(0)
})
