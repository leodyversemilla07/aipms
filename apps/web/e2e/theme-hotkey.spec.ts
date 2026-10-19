import { expect, test } from "@playwright/test"

/**
 * The global theme hotkey listens on `window`, so it sees every keydown the
 * browser dispatches - including synthetic ones without a `key` property.
 * Those must be ignored, not crash the page.
 */
test("theme hotkey ignores keyless synthetic key events", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))

  await page.goto("/")
  await page.evaluate(() => {
    window.dispatchEvent(new Event("keydown"))
    window.dispatchEvent(new Event("keydown", { bubbles: true }))
  })
  await page.waitForTimeout(500)
  expect(errors).toEqual([])

  // A real key press still toggles the theme.
  await page.keyboard.press("d")
  await expect(page.locator("html")).toHaveClass(/dark/)
})
