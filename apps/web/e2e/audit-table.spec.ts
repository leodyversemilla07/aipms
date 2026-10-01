import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { db } from "../../../packages/db/src/index"

const fixtureEntity = `E2EAudit:${randomUUID()}`

test.beforeAll(async () => {
  // UI pagination needs its own history, not rows produced by other specs.
  // These are legacy (unchained) fixtures; do not delete append-only evidence
  // or fabricate hashes. The chain verifier explicitly counts legacy rows.
  const start = Date.UTC(2025, 0, 1)
  await db.auditEntry.createMany({
    data: Array.from({ length: 51 }, (_, index) => ({
      actorId: "e2e-audit-pagination",
      actorKind: "human" as const,
      action: `pagination.fixture-${index}`,
      entity: fixtureEntity,
      entityId: `fixture-${index}`,
      at: new Date(start + index * 1000),
    })),
  })
})

test("full chain verification runs only on request", async ({ page }) => {
  let checks = 0
  page.on("request", (request) => {
    if (request.url().includes("audit.chain")) checks++
  })
  await page.goto("/audit")
  // Verification is available even when the audit feed is empty.
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Verify full chain" })
  ).toBeVisible()
  expect(checks).toBe(0)
  await page.getByRole("button", { name: "Verify full chain" }).click()
  await expect(
    page.getByText("Chain intact at last check", { exact: true })
  ).toBeVisible()
  expect(checks).toBe(1)
})

test("audit entries are server-paginated and filters reset the page", async ({
  page,
}) => {
  await page.goto("/audit")
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible()
  // Isolate the result set from concurrent writers and earlier test runs.
  await page
    .getByRole("combobox", { name: "Filter by entity" })
    .selectOption(fixtureEntity)
  const table = page.getByRole("table")
  await expect(table.getByRole("columnheader")).toHaveCount(5)
  await expect(table.getByRole("row")).toHaveCount(26)
  const firstRow = await table.getByRole("row").nth(1).innerText()

  await page
    .getByRole("navigation", { name: "pagination" })
    .getByRole("button", { name: "Next", exact: true })
    .click()
  await expect(page.getByRole("status").getByText(/Page 2 of/)).toBeVisible()
  await expect(table.getByRole("row")).toHaveCount(26)
  await expect(table.getByRole("row").nth(1)).not.toHaveText(firstRow)

  await page
    .getByRole("textbox", { name: "Search audit entries" })
    .fill("no-such-audit-entry-xyz")
  await expect(page.getByText("No matching entries")).toBeVisible()
  await expect(
    page.getByRole("navigation", { name: "pagination" })
  ).toHaveCount(0)

  await page.getByRole("textbox", { name: "Search audit entries" }).clear()
  await expect(page.getByRole("status").getByText(/Page 1 of/)).toBeVisible()
  await expect(table.getByRole("row")).toHaveCount(26)
})
