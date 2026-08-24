import { expect, test } from "@playwright/test"

/**
 * §8.1 procure-to-pay happy path driven through the real UI:
 * requisition → auto-approve (below threshold, budgeted) → PO issue →
 * goods receipt → over-receipt refused.
 *
 * Amounts stay small so the seeded ₱50k threshold policy auto-approves.
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const description = `E2E paper ${suffix}`

test("requisition → PO → receipt, over-receipt refused", async ({ page }) => {
  // ── 1. Raise a requisition on the supervisory desk ──────────────────────
  await page.goto("/")
  await page.getByRole("button", { name: "Compose" }).click()
  await page.getByLabel("Budget").selectOption({ index: 1 })
  await page.getByPlaceholder("Line 1 description").fill(description)
  await page
    .getByPlaceholder("Line 1 description")
    .locator("xpath=..")
    .locator("input[type=number]")
    .first()
    .fill("3")
  await page.getByPlaceholder("₱ unit").fill("250")
  await page.getByRole("button", { name: "Create & submit" }).click()

  await expect(page.getByText(/created and submitted\./)).toBeVisible({
    timeout: 15_000,
  })

  // Map our unique line description → its requisition number via tRPC.
  const listRes = await page.request.get(
    "/api/trpc/requisition.list?input=" +
      encodeURIComponent(
        JSON.stringify({ json: { q: "", page: 1, pageSize: 50 } })
      )
  )
  const rows = (
    (await listRes.json()) as {
      result?: { data?: { rows?: { id: string; requestNumber: string; lines: { description: string }[] }[] } }
    }
  ).result?.data?.rows
  const mine = rows?.find((r) =>
    r.lines.some((l) => l.description === description)
  )
  expect(mine, "created requisition appears in the API list").toBeTruthy()

  // ── 2. Issue a PO from it on the procurement desk ───────────────────────
  await page.goto("/procurement")
  const card = page.locator("li", {
    hasText: mine!.requestNumber,
  })
  await expect(card).toBeVisible({ timeout: 20_000 })

  const vendorSelect = card.locator("select")
  await vendorSelect.selectOption({ label: "Acme Office Supplies, Inc." })
  await card.getByRole("button", { name: "Issue PO" }).click()

  await expect(card.getByText(/PO \S+ issued — budget committed/)).toBeVisible({
    timeout: 15_000,
  })
  const poNumber = (
    (await card.getByText(/PO \S+ issued/).innerText()).match(/PO-\d+/) ?? []
  )[0]
  expect(poNumber).toBeTruthy()

  // The new PO appears in the purchase-order feed as Issued.
  const poSection = page.getByText("Purchase orders").locator("../..")
  await expect(poSection.getByText(poNumber!)).toBeVisible()

  // ── 3. Record a full goods receipt against it ───────────────────────────
  await page.getByRole("button", { name: "Record a delivery…" }).click()
  await page.getByText("Choose a PO…").click()
  await page.locator('[role="option"]').first().click()

  const qtyInput = page.locator('input[placeholder="received"]').first()
  await qtyInput.fill("3")
  await page.getByRole("button", { name: "Record receipt" }).click()
  await expect(page.getByText(/Receipt recorded against/)).toBeVisible({
    timeout: 15_000,
  })

  // ── 4. Over-receipt is refused server-side and surfaced verbatim ────────
  await page.getByRole("button", { name: "Record a delivery…" }).click()
  await page.getByText("Choose a PO…").click()
  await page.locator('[role="option"]').first().click()
  await page.locator('input[placeholder="received"]').first().fill("5")
  await page.getByRole("button", { name: "Record receipt" }).click()
  await expect(page.getByText(/exceeds the ordered/)).toBeVisible({
    timeout: 15_000,
  })
})
