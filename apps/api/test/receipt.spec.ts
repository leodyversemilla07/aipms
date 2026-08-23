import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PolicyService } from '../src/policy/policy.service'
import { ReceiptService } from '../src/receipt/receipt.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * §8.1 receipts — the middle leg of the three-way match: over-receipt gates,
 * PO-lifecycle validation, and re-matching invoices parked awaiting goods.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorId = `test-user-${suffix}`

const created: Record<string, string[]> = {
  invoice: [],
  po: [],
  vendor: [],
  receipt: [],
}

const invoiceService = new InvoiceService(
  new PolicyService(),
  new EventEmitterService(),
)
const receipts = new ReceiptService(
  new DocumentNumberService(),
  new EventEmitterService(),
  invoiceService,
)

afterAll(async () => {
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.receipt.deleteMany({ where: { id: { in: created.receipt } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.$disconnect()
})

let vendorId: string

beforeAll(async () => {
  const vendor = await db.vendor.create({
    data: { name: `Receipt Vendor ${suffix}`, status: 'active' },
  })
  vendorId = vendor.id
  created.vendor.push(vendor.id)
})

async function makePo(
  tag: string,
  opts: {
    status?: 'draft' | 'issued' | 'confirmed'
    totalMinor?: number
    withLines?: boolean
  } = {},
) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-RCT-${tag}-${suffix}`,
      vendorId,
      status: opts.status ?? 'issued',
      totalMinor: opts.totalMinor ?? 100_000,
      issuedBy: actorId,
      lines: opts.withLines
        ? {
            create: [
              {
                lineNo: 1,
                description: 'A4 bond paper',
                quantity: 10,
                unitPriceMinor: 10_000,
                lineTotalMinor: 100_000,
              },
            ],
          }
        : undefined,
    },
    include: { lines: true },
  })
  created.po.push(po.id)
  return po
}

const line = { amountMinor: 100_000, class: 'goods' as const }

describe('ReceiptService (§8.1)', () => {
  it('rejects receipting against a draft PO', async () => {
    const po = await makePo('draft', { status: 'draft' })
    await expect(
      receipts.record({
        poId: po.id,
        lines: [{ lineNo: 1, description: 'x', quantity: 1 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/only be received against an issued or confirmed/)
  })

  it('rejects an unknown PO and empty line sets', async () => {
    await expect(
      receipts.record({
        poId: 'no-such-po',
        lines: [{ description: 'x', quantity: 1 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/not found/)

    const po = await makePo('empty')
    await expect(
      receipts.record({ poId: po.id, lines: [], recordedBy: actorId }),
    ).rejects.toThrow(/at least one line/)
  })

  it('records a receipt with a sequential number and links PO lines', async () => {
    const po = await makePo('ok', { withLines: true })
    const { receipt, rematch } = await receipts.record({
      poId: po.id,
      lines: [
        {
          lineNo: 1,
          sku: 'A4-BOND-70',
          description: 'A4 bond paper',
          quantity: 6,
        },
      ],
      note: 'partial delivery',
      recordedBy: actorId,
    })
    created.receipt.push((receipt as { id: string }).id)

    expect((receipt as { receiptNumber: string }).receiptNumber).toMatch(
      /^RCT-\d{6}$/,
    )
    const lines = (receipt as { lines: { poLineId: string | null }[] }).lines
    expect(lines[0].poLineId).toBe(po.lines[0].id)
    // No invoices on this PO yet — nothing to re-match.
    expect(rematch.considered).toBe(0)
  })

  it('blocks over-receipt beyond the ordered quantity per PO line', async () => {
    const po = await makePo('over', { withLines: true }) // ordered 10 @ line 1
    const first = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 7 }],
      recordedBy: actorId,
    })
    created.receipt.push((first.receipt as { id: string }).id)

    await expect(
      receipts.record({
        poId: po.id,
        lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 4 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/Over-receipt.*exceeds the ordered 10/)

    // Exactly filling the remainder is allowed.
    const rest = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 3 }],
      recordedBy: actorId,
    })
    created.receipt.push((rest.receipt as { id: string }).id)
  })

  it('re-matches parked invoices when the goods arrive', async () => {
    const po = await makePo('parked', { withLines: true })
    const { invoice } = await invoiceService.register({
      vendorId,
      number: `INV-PARKED-${suffix}`,
      poId: po.id,
      lines: [line],
    })
    created.invoice.push((invoice as { id: string }).id)
    expect((invoice as { status: string }).status).toBe('received') // awaiting

    const { receipt, rematch } = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 10 }],
      recordedBy: actorId,
    })
    created.receipt.push((receipt as { id: string }).id)
    expect(rematch.considered).toBe(1)
    expect(rematch.matched).toBe(1)

    const after = await db.invoice.findUnique({
      where: { id: (invoice as { id: string }).id },
    })
    expect(after?.status).toBe('matched')
  })

  it('raises a receipt_shortfall exception when received value lags the invoice', async () => {
    const po = await makePo('short', { withLines: true })
    // Only half the goods arrive…
    const partial = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 5 }],
      recordedBy: actorId,
    })
    created.receipt.push((partial.receipt as { id: string }).id)

    // …but the full amount is invoiced → shortfall beyond tolerance.
    await invoiceService.register({
      vendorId,
      number: `INV-SHORT-${suffix}`,
      poId: po.id,
      lines: [line],
    })
    const stored = await db.invoice.findUnique({
      where: { vendorId_number: { vendorId, number: `INV-SHORT-${suffix}` } },
    })
    if (stored) created.invoice.push(stored.id)

    expect(stored?.matchResult).toMatchObject({ outcome: 'receipt_shortfall' })
    expect(stored?.status).toBe('exception')
  })

  it('cancels a receipt once, and only once', async () => {
    const po = await makePo('cancel')
    const { receipt } = await receipts.record({
      poId: po.id,
      lines: [{ description: 'mystery box', quantity: 1 }],
      recordedBy: actorId,
    })
    created.receipt.push((receipt as { id: string }).id)

    const cancelled = (await receipts.cancel(
      (receipt as { id: string }).id,
    )) as { status: string }
    expect(cancelled.status).toBe('cancelled')

    await expect(
      receipts.cancel((receipt as { id: string }).id),
    ).rejects.toThrow(/already cancelled/)
  })

  it('lists receipts filtered by PO', async () => {
    const all = await receipts.list({})
    expect(all.total).toBeGreaterThan(0)
    const rows = all.rows as { poId: string }[]
    const target = rows[0].poId
    const filtered = await receipts.list({ poId: target })
    for (const row of filtered.rows as { poId: string }[]) {
      expect(row.poId).toBe(target)
    }
  })
})
