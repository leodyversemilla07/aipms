import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BirService } from '../src/bir/bir.service'

/**
 * §8.4 BIR statutory reports — deterministic 2307 certificates and 1601-E
 * monthly remittance summaries derived from stored invoice tax data.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const PERIOD_A = '2026-05'
const PERIOD_B = '2026-06'

const created: Record<string, string[]> = {
  invoice: [],
  vendor: [],
}

afterAll(async () => {
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.$disconnect()
})

let vendorAId: string
let vendorBId: string

beforeAll(async () => {
  const a = await db.vendor.create({
    data: {
      name: `BIR Vendor A ${suffix}`,
      status: 'active',
      taxId: `TIN-A-${suffix}`,
    },
  })
  const b = await db.vendor.create({
    data: {
      name: `BIR Vendor B ${suffix}`,
      status: 'active',
      taxId: `TIN-B-${suffix}`,
    },
  })
  vendorAId = a.id
  vendorBId = b.id
  created.vendor.push(a.id, b.id)

  const rows = [
    // Vendor A, period A: two invoices withheld at 1% (goods).
    {
      vendorId: vendorAId,
      number: `INV-2307-A1-${suffix}`,
      amountMinor: 100_000,
      ewtMinor: 1_000,
      receivedAt: new Date(Date.UTC(2026, 4, 3)),
    },
    {
      vendorId: vendorAId,
      number: `INV-2307-A2-${suffix}`,
      amountMinor: 200_000,
      ewtMinor: 2_000,
      receivedAt: new Date(Date.UTC(2026, 4, 20)),
    },
    // Vendor B, period A: one invoice withheld at 5% (rental).
    {
      vendorId: vendorBId,
      number: `INV-2307-B1-${suffix}`,
      amountMinor: 50_000,
      ewtMinor: 2_500,
      receivedAt: new Date(Date.UTC(2026, 4, 10)),
    },
    // Vendor A, period B: withholding lands in the *next* month.
    {
      vendorId: vendorAId,
      number: `INV-2307-A3-${suffix}`,
      amountMinor: 80_000,
      ewtMinor: 800,
      receivedAt: new Date(Date.UTC(2026, 5, 2)),
    },
    // No EWT withheld — must never appear on any form.
    {
      vendorId: vendorAId,
      number: `INV-NOEWT-${suffix}`,
      amountMinor: 90_000,
      ewtMinor: 0,
      receivedAt: new Date(Date.UTC(2026, 4, 15)),
    },
  ]
  for (const row of rows) {
    const inv = await db.invoice.create({ data: row })
    created.invoice.push(inv.id)
  }
})

describe('BirService (§8.4)', () => {
  it('issues a per-supplier 2307 certificate with correct totals and policy citations', async () => {
    const svc = new BirService()
    const cert = await svc.form2307({ vendorId: vendorAId, period: PERIOD_A })

    expect(cert.form).toBe('2307')
    expect(cert.vendor.taxId).toBe(`TIN-A-${suffix}`)
    expect(cert.lines.map((l) => l.number)).toEqual([
      `INV-2307-A1-${suffix}`,
      `INV-2307-A2-${suffix}`,
    ])
    expect(cert.totals).toEqual({
      baseAmountMinor: 300_000,
      taxWithheldMinor: 3_000,
    })
    for (const line of cert.lines) {
      expect(typeof line.taxPolicyVersion === 'string' || line.taxPolicyVersion === null).toBe(
        true,
      )
    }
  })

  it('keeps periods separate on the certificate', async () => {
    const svc = new BirService()
    const june = await svc.form2307({ vendorId: vendorAId, period: PERIOD_B })
    expect(june.lines.map((l) => l.number)).toEqual([`INV-2307-A3-${suffix}`])
    expect(june.totals).toEqual({
      baseAmountMinor: 80_000,
      taxWithheldMinor: 800,
    })

    const empty = await svc.form2307({
      vendorId: vendorBId,
      period: PERIOD_B,
    })
    expect(empty.lines).toEqual([])
    expect(empty.totals.taxWithheldMinor).toBe(0)
  })

  it('aggregates 1601-E remittance totals per supplier for the month', async () => {
    const svc = new BirService()
    const summary = await svc.summary1601e({ period: PERIOD_A })

    expect(summary.form).toBe('1601-E')
    const mine = summary.suppliers.filter((s) =>
      [vendorAId, vendorBId].includes(s.vendorId),
    )
    expect(mine).toHaveLength(2)

    const rowA = summary.suppliers.find((s) => s.vendorId === vendorAId)
    expect(rowA).toMatchObject({
      name: `BIR Vendor A ${suffix}`,
      taxId: `TIN-A-${suffix}`,
      invoiceCount: 2,
      baseAmountMinor: 300_000,
      taxWithheldMinor: 3_000,
    })
    const rowB = summary.suppliers.find((s) => s.vendorId === vendorBId)
    expect(rowB).toMatchObject({
      invoiceCount: 1,
      baseAmountMinor: 50_000,
      taxWithheldMinor: 2_500,
    })

    expect(summary.totals.invoiceCount).toBeGreaterThanOrEqual(3)
    expect(summary.totals.baseAmountMinor).toBeGreaterThanOrEqual(350_000)
    expect(summary.totals.taxWithheldMinor).toBeGreaterThanOrEqual(5_500)
  })

  it('is deterministic — identical inputs produce identical reports', async () => {
    const svc = new BirService()
    const first = JSON.stringify(await svc.summary1601e({ period: PERIOD_A }))
    const second = JSON.stringify(await svc.summary1601e({ period: PERIOD_A }))
    expect(first).toBe(second)

    const c1 = JSON.stringify(
      await svc.form2307({ vendorId: vendorAId, period: PERIOD_A }),
    )
    const c2 = JSON.stringify(
      await svc.form2307({ vendorId: vendorAId, period: PERIOD_A }),
    )
    expect(c1).toBe(c2)
  })

  it('rejects malformed periods and unknown vendors', async () => {
    const svc = new BirService()
    await expect(svc.summary1601e({ period: '2026/05' })).rejects.toThrow(
      /Invalid period/,
    )
    await expect(svc.summary1601e({ period: '26-05' })).rejects.toThrow(
      /Invalid period/,
    )
    await expect(
      svc.form2307({ vendorId: 'no-such-vendor', period: PERIOD_A }),
    ).rejects.toThrow(/not found/)
  })

  it('lists periods that carry withholding data, newest first', async () => {
    const svc = new BirService()
    const { rows } = await svc.list({})
    const periods = rows.map((r) => r.period)
    expect(periods).toContain(PERIOD_A)
    expect(periods).toContain(PERIOD_B)
    for (let i = 1; i < periods.length; i++) {
      expect(periods[i - 1] >= periods[i]).toBe(true)
    }
    const may = rows.find((r) => r.period === PERIOD_A)
    expect(may?.invoiceCount).toBeGreaterThanOrEqual(3)
  })
})
