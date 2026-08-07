import { db } from "../src/client"

/**
 * Idempotent enterprise demo master data. Seeds the supervisory & finance
 * desks with a working catalog, an active vendor with a verified beneficiary
 * bank account (§8.6), an approved budget, and a default §10.1 threshold
 * policy. Operative flows (requisition -> approval -> PO -> invoice -> run)
 * remain exercised through the API/UI.
 *
 * Safe to re-run: every insert is keyed (upsert / findFirst-guard).
 */
async function main() {
  await db.budget.upsert({
    where: { costCenter_period: { costCenter: "IT-PROD", period: "2026-01" } },
    update: {},
    create: {
      name: "IT Production Ops",
      costCenter: "IT-PROD",
      period: "2026-01",
      currencyCode: "PHP",
      limitMinor: 5_000_00000, // ₱5,000,000
    },
  })
  console.log("seeded budget")

  const vendor = await db.vendor.findFirst({
    where: { name: "Acme Office Supplies, Inc." },
  })
  if (!vendor) {
    await db.vendor.create({
      data: {
        name: "Acme Office Supplies, Inc.",
        status: "active",
        email: "billing@acme.example",
        taxId: "000-123-456-000",
        paymentTermsDays: 30,
        ratingScore: 92,
        qualifiedEntityClass: "catalog",
        // §8.6 beneficiary control: verified once at creation; a bank-account
        // change clears the stamp and forces re-verification before pay runs.
        bankAccount: {
          bank: "BDO",
          accountNumber: "0000123456789",
          holder: "Acme Office Supplies, Inc.",
        },
        bankAccountVerifiedAt: new Date(),
        bankAccountChangedAt: new Date(),
      },
    })
  }
  console.log("seeded vendor")

  const items = [
    {
      sku: "A4-BOND-70",
      name: "A4 bond paper 70gsm (ream)",
      category: "office-supplies",
      unit: "ream",
      defaultPriceMinor: 250_00, // ₱250
    },
    {
      sku: "TONER-BK-01",
      name: "Toner cartridge, black (OEM)",
      category: "office-supplies",
      unit: "ea",
      defaultPriceMinor: 3500_00, // ₱3,500
    },
  ]
  for (const item of items) {
    await db.catalogItem.upsert({ where: { sku: item.sku }, update: {}, create: item })
  }
  console.log("seeded catalog")

  const threshold = await db.policy.findFirst({
    where: { kind: "threshold", enabled: true },
  })
  if (!threshold) {
    await db.policy.create({
      data: {
        name: "Requisition threshold (default)",
        kind: "threshold",
        enabled: true,
        version: 1,
        config: {
          autoApproveUpTo: 50_00000, // ₱50,000 auto-approve
          budgetRequired: false,
        },
        updatedBy: "seed",
      },
    })
  }
  console.log("seeded policy")
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })