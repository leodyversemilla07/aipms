import { expect, test } from "@playwright/test"

test("audit entries are server-paginated and filters reset the page", async ({
  page,
}) => {
  await page.goto("/audit")
  await expect(page.getByRole("heading", { name: "Audit trail" })).toBeVisible()
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
  expect(await table.getByRole("row").nth(1).innerText()).not.toBe(firstRow)

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
