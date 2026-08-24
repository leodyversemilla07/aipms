import { expect, test } from "@playwright/test"

/**
 * §8.3 messaging relay approvals + §8.4/§8.5 finance surfaces.
 * The gated message is seeded over tRPC (agents submit through the same
 * procedure), then approved from the desk like a human operator would.
 */

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const subject = `E2E contract renewal ${suffix}`

async function trpcGet(
  request: import("@playwright/test").APIRequestContext,
  path: string,
  input: unknown
): Promise<Record<string, unknown>> {
  const res = await request.get(`http://127.0.0.1:3001/api/trpc/${path}`, {
    params: { input: JSON.stringify({ json: input }) },
  })
  expect(res.ok(), `tRPC ${path} failed`).toBeTruthy()
  return (await res.json()) as Record<string, unknown>
}

test("gated message queues, approves, and lands in sent", async ({ page }) => {
  // Seed a gated (free-form) message for the seeded vendor — same tRPC
  // procedure the agent uses.
  const vendorRes = await trpcGet(page.request, "vendor.list", {
    q: "",
    page: 1,
    pageSize: 5,
  })
  const vendors = (
    vendorRes as {
      result?: { data?: { rows?: { id: string; name: string }[] } }
    }
  ).result?.data?.rows
  expect(vendors?.length).toBeGreaterThan(0)

  await page.request.post("http://127.0.0.1:3000/api/trpc/messaging.submit", {
    data: {
      idempotencyKey: `e2e-msg-${suffix}`,
      vendorId: vendors![0]!.id,
      recipient: "billing@acme.example",
      subject,
      body: "We would like to discuss annual pricing for office supplies.",
    },
  })

  // The queued view shows it queued + gated.
  await page.goto("/procurement")
  const item = page.locator("li", { hasText: subject }).first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await expect(item.getByText("gated")).toBeVisible()

  // Approve → relay sends → the row leaves "queued".
  await item.getByRole("button", { name: "Approve", exact: true }).click()

  // Switch to the sent filter and confirm it landed there.
  await page.getByRole("button", { name: "sent" }).click()
  const sentItem = page.locator("li", { hasText: subject }).first()
  await expect(sentItem).toBeVisible({ timeout: 15_000 })
  await expect(sentItem.getByText("sent")).toBeVisible()
})

test("BIR report and ERP reconciliation render against live data", async ({
  page,
}) => {
  await page.goto("/finance")

  await expect(page.getByText("BIR withholding (2307 / 1601-E)")).toBeVisible()
  await expect(
    page.getByRole("combobox", { name: "Period" })
  ).toBeVisible()

  await expect(page.getByText("QuickBooks Online")).toBeVisible()
  await expect(page.getByText(/not connected|connected/).first()).toBeVisible()
})
