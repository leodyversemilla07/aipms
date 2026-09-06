import { expect, test } from "@playwright/test"

test.use({ storageState: { cookies: [], origins: [] } })

test("sign-in supports provisioned users without exposing public enrollment", async ({
  page,
}) => {
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
})
