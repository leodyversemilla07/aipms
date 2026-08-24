import { expect, type Page, test as setup } from "@playwright/test"

const stateFile = "e2e/.auth/maker.json"

/** Sign in via the web app's proxied Better Auth surface (same-origin),
 * so the session cookie is scoped to exactly the host we browse. */
async function signInViaApi(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: {
      email: "maker@demo.aipms",
      password: "demo-maker-123",
    },
  })
  expect(res.ok()).toBeTruthy()
}

setup("authenticate as demo maker", async ({ page }) => {
  await signInViaApi(page)

  // The cookie is host-scoped, so it covers :3000 on the same host too — verify
  // by loading a page that requires a session.
  await page.goto("/")
  await expect(page.getByText("Supervisory desk")).toBeVisible({
    timeout: 20_000,
  })

  await page.request.storageState({ path: stateFile })
})
