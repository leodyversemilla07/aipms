import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PolicyService } from '../src/policy/policy.service'

/**
 * @workspace invoice service — deterministic §8.4 tax foot + §9 three-way
 * match against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorId = `test-user-${suffix}`

const created: Record<string, string[]> = {
  invoice: [],
  po: [],
  vendor: [],
  policy: [],
}

const policyService = new PolicyService()
const invoiceService = new InvoiceService(policyService)

afterAll(async () => {
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.$disconnect()
})

async function makeVendor() {
  const vendor = await db.vendor.create({
    data: {
      name: `Vendor ${suffix}`,
      status: 'active',
      taxId: `TAX-${suffix}`,
    },
  })
  created.vendor.push(vendor.id)
  return vendor
}

async function makePo(vendorId: string, totalMinor: number, tag: string) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-INV-${tag}-${suffix}`,
      vendorId,
      status: 'issued',
      totalMinor,
      issuedBy: actorId,
    },
  })
  created.po.push(po.id)
  return po
}

const line = { amountMinor: 100_000, class: 'goods' as const }

describe('Deterministic tax (§8.4)', () => {
  it('computes VAT + EWT foot for an invoice against the default PH policy', async () => {
    const comp = await invoiceService.compute({ lines: [line] })
    expect(comp.vatMinor).toBe(12_000) // 12% of ₱1,000.00
    expect(comp.ewtMinor).toBe(1_000) // 1% goods
    expect(comp.netPayableMinor).toBe(100_000 + 12_000 - 1_000)
  })

  it('honours a configured taxRule policy (config-over-fork)', async () => {
    await policyService.create({
      name: `Tax ${suffix}`,
      kind: 'taxRule',
      updatedBy: actorId,
      config: { vatRateBps: 1200, ewtRatesBps: { goods: 100, services: 300 } },
    })
    const comp = await invoiceService.compute({ lines: [line] })
    expect(comp.vatMinor).toBe(12_000)
    expect(comp.ewtMinor).toBe(1_000)
  })
})

describe('Three-way match + invoice registration', () => {
  it('registers a matched invoice with tax fields and status matched', async () => {
    const vendor = await makeVendor()
    const po = await makePo(vendor.id, 100_000, 'ok')

    const { invoice, match } = await invoiceService.register({
      vendorId: vendor.id,
      number: `INV-OK-${suffix}`,
      poId: po.id,
      lines: [line],
    })
    created.invoice.push((invoice as { id: string }).id)

    expect((invoice as { amountMinor: number }).amountMinor).toBe(100_000)
    expect((invoice as { vatMinor: number }).vatMinor).toBe(12_000)
    expect((invoice as { ewtMinor: number }).ewtMinor).toBe(1_000)
    expect((invoice as { status: string }).status).toBe('matched')
    expect(match?.outcome).toBe('matched')
    expect(match?.varianceMinor).toBe(0)
  })

  it('flags an amount variance beyond tolerance as an exception', async () => {
    const vendor = await makeVendor()
    const po = await makePo(vendor.id, 80_000, 'amt') // invoice is 100_000

    const { invoice, match } = await invoiceService.register({
      vendorId: vendor.id,
      number: `INV-002-${suffix}`,
      poId: po.id,
      lines: [line],
    })
    created.invoice.push((invoice as { id: string }).id)

    expect((invoice as { status: string }).status).toBe('exception')
    expect(match?.outcome).toBe('amount_mismatch')
    expect(match?.amountMatched).toBe(false)
  })

  it('flags a vendor mismatch as an exception', async () => {
    const poVendor = await makeVendor()
    const otherVendor = await makeVendor()
    const po = await makePo(poVendor.id, 100_000, 'vm')

    const { invoice, match } = await invoiceService.register({
      vendorId: otherVendor.id,
      number: `INV-003-${suffix}`,
      poId: po.id,
      lines: [line],
    })
    created.invoice.push((invoice as { id: string }).id)

    expect((invoice as { status: string }).status).toBe('exception')
    expect(match?.outcome).toBe('vendor_mismatch')
    expect(match?.vendorMatched).toBe(false)
  })

  it('dedupes a re-ingested [vendor, number] to the existing invoice', async () => {
    const vendor = await makeVendor()
    const first = await invoiceService.register({
      vendorId: vendor.id,
      number: `INV-004-${suffix}`,
      lines: [line],
    })
    created.invoice.push((first.invoice as { id: string }).id)

    const again = await invoiceService.register({
      vendorId: vendor.id,
      number: `INV-004-${suffix}`,
      lines: [line],
    })
    expect((again.invoice as { id: string }).id).toBe(
      (first.invoice as { id: string }).id,
    )
  })
})
