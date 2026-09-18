import { expect, type Page, test as setup } from "@playwright/test"

const makerStateFile = "e2e/.auth/maker.json"
const checkerStateFile = "e2e/.auth/checker.json"

/** Sign in via the web app's proxied Better Auth surface (same-origin),
 * so the session cookie is scoped to exactly the host we browse. */
async function signInViaApi(
  page: Page,
  credentials: { email: string; password: string }
): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: credentials,
  })
  expect(res.ok()).toBeTruthy()
}

setup("authenticate demo maker and checker", async ({ page }) => {
  await signInViaApi(page, {
    email: "maker@demo.aipms",
    password: "demo-maker-123",
  })

  // The cookie is host-scoped, so it covers :3000 on the same host too — verify
  // by loading a page that requires a session.
  await page.goto("/")
  await expect(page.getByText("Supervisory desk")).toBeVisible({
    timeout: 20_000,
  })
  await page.request.storageState({ path: makerStateFile })

  // Provision the independent checker context before parallel tests begin.
  // This avoids runtime sign-in contention and makes dual-control scenarios
  // use the exact same persisted-browser-session path as the maker.
  await page.context().clearCookies()
  await signInViaApi(page, {
    email: "checker@demo.aipms",
    password: "demo-checker-123",
  })
  await page.goto("/")
  await expect(page.getByText("Supervisory desk")).toBeVisible({
    timeout: 20_000,
  })
  await page.request.storageState({ path: checkerStateFile })
})
