import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PolicyService } from '../src/policy/policy.service'
import { ReceiptService } from '../src/receipt/receipt.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * PO/receipt/invoice allocation invariants (§8.1, §9):
 *
 * - duplicate receipt lines in one request share a single quantity cap;
 * - one PO/receipt value cannot make two full-value invoices payable;
 * - receipt cancellation demotes dependent invoices atomically, and is
 *   refused while a matched invoice is claimed by a live payment run;
 * - shortfall exceptions recover when the remaining goods arrive.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorId = `test-user-${suffix}`

const created: Record<string, string[]> = {
  invoice: [],
  po: [],
  vendor: [],
  receipt: [],
  run: [],
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
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.receipt.deleteMany({ where: { id: { in: created.receipt } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.$disconnect()
})

let vendorId: string

beforeAll(async () => {
  const vendor = await db.vendor.create({
    data: { name: `Alloc Vendor ${suffix}`, status: 'active' },
  })
  vendorId = vendor.id
  created.vendor.push(vendor.id)
})

/** Issued PO for 10 units @ 10_000 = 100_000. */
async function makePo(tag: string, status = 'issued' as const) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-ALLOC-${tag}-${suffix}`,
      vendorId,
      status,
      totalMinor: 100_000,
      issuedBy: actorId,
      lines: {
        create: [
          {
            lineNo: 1,
            description: 'A4 bond paper',
            quantity: 10,
            unitPriceMinor: 10_000,
            lineTotalMinor: 100_000,
          },
        ],
      },
    },
    include: { lines: true },
  })
  created.po.push(po.id)
  return po
}

function goodsLine(amountMinor: number) {
  return { amountMinor, class: 'goods' as const }
}

async function registerInvoice(poId: string, number: string, amount = 100_000) {
  const { invoice, match } = await invoiceService.register({
    vendorId,
    number: `${number}-${suffix}`,
    poId,
    lines: [goodsLine(amount)],
  })
  created.invoice.push((invoice as { id: string }).id)
  return { invoice, match }
}

describe('Receipt quantity cap within one request', () => {
  it('rejects duplicate lines whose combined quantity exceeds the order', async () => {
    const po = await makePo('dup')
    await expect(
      receipts.record({
        poId: po.id,
        lines: [
          { lineNo: 1, description: 'A4 bond paper', quantity: 6 },
          {
            lineNo: 1,
            description: 'A4 bond paper (second pallet)',
            quantity: 6,
          },
        ],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/Over-receipt.*exceeds the ordered 10/)
    expect(await db.receipt.count({ where: { poId: po.id } })).toBe(0)
  })

  it('accepts duplicate lines that exactly fill the order', async () => {
    const po = await makePo('dup-ok')
    const { receipt } = await receipts.record({
      poId: po.id,
      lines: [
        { lineNo: 1, description: 'A4 bond paper', quantity: 6 },
        {
          lineNo: 1,
          description: 'A4 bond paper (second pallet)',
          quantity: 4,
        },
      ],
      recordedBy: actorId,
    })
    created.receipt.push((receipt as { id: string }).id)
    const lines = (receipt as { lines: { quantity: number }[] }).lines
    expect(lines.reduce((sum, l) => sum + l.quantity, 0)).toBe(10)
  })

  it('counts poLineId-only lines against the same cap', async () => {
    const po = await makePo('by-id')
    const poLineId = po.lines[0].id
    await receipts
      .record({
        poId: po.id,
        lines: [{ poLineId, description: 'A4 bond paper', quantity: 7 }],
        recordedBy: actorId,
      })
      .then(({ receipt }) =>
        created.receipt.push((receipt as { id: string }).id),
      )
    await expect(
      receipts.record({
        poId: po.id,
        lines: [{ lineNo: 1, description: 'more paper', quantity: 4 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/Over-receipt.*exceeds the ordered 10/)
  })

  it('rejects mismatched poLineId/lineNo pairs and unknown lines', async () => {
    const po = await makePo('mismatch')
    const poLineId = po.lines[0].id
    await expect(
      receipts.record({
        poId: po.id,
        lines: [{ poLineId, lineNo: 2, description: 'x', quantity: 1 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/not line 2/)
    await expect(
      receipts.record({
        poId: po.id,
        lines: [{ poLineId: 'no-such-line', description: 'x', quantity: 1 }],
        recordedBy: actorId,
      }),
    ).rejects.toThrow(/is not on PO/)
  })
})

describe('Invoice allocation against PO/receipt capacity', () => {
  it('refuses a second full-value invoice once capacity is consumed', async () => {
    const po = await makePo('double')
    const full = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 10 }],
      recordedBy: actorId,
    })
    created.receipt.push((full.receipt as { id: string }).id)

    const first = await registerInvoice(po.id, 'INV-ALLOC-A')
    expect((first.invoice as { status: string }).status).toBe('matched')

    const second = await registerInvoice(po.id, 'INV-ALLOC-B')
    expect((second.invoice as { status: string }).status).toBe('exception')
    expect(second.match).toMatchObject({
      outcome: 'over_allocated',
      allocatedMinor: 100_000,
      receivedValueMinor: 100_000,
    })
  })

  it('rejects invoices against a non-live PO and in the wrong currency', async () => {
    const cancelled = await makePo('cancelled', 'cancelled')
    const { invoice, match } = await registerInvoice(cancelled.id, 'INV-DEAD')
    expect((invoice as { status: string }).status).toBe('exception')
    expect(match?.outcome).toBe('po_not_live')

    const po = await makePo('fx')
    const { invoice: fx, match: fxMatch } = await invoiceService.register({
      vendorId,
      number: `INV-FX-${suffix}`,
      poId: po.id,
      currencyCode: 'USD',
      lines: [goodsLine(100_000)],
    })
    created.invoice.push((fx as { id: string }).id)
    expect((fx as { status: string }).status).toBe('exception')
    expect(fxMatch?.outcome).toBe('currency_mismatch')
  })
})

describe('Receipt cancellation and invoice eligibility', () => {
  it('demotes a matched invoice when its receipt is cancelled', async () => {
    const po = await makePo('demote')
    const { receipt } = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 10 }],
      recordedBy: actorId,
    })
    const receiptId = (receipt as { id: string }).id
    created.receipt.push(receiptId)

    const { invoice } = await registerInvoice(po.id, 'INV-DEMOTE')
    const invoiceId = (invoice as { id: string }).id
    expect((invoice as { status: string }).status).toBe('matched')

    await receipts.cancel(receiptId)
    const after = await db.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
    })
    // No goods left standing: parked awaiting receipts, not payable.
    expect(after.status).toBe('received')
    expect(after.matchResult).toMatchObject({ outcome: 'awaiting_receipt' })
  })

  it('refuses cancellation while a matched invoice is in a live payment run', async () => {
    const po = await makePo('claimed')
    const { receipt } = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 10 }],
      recordedBy: actorId,
    })
    const receiptId = (receipt as { id: string }).id
    created.receipt.push(receiptId)

    const { invoice } = await registerInvoice(po.id, 'INV-CLAIMED')
    const invoiceId = (invoice as { id: string }).id

    const run = await db.paymentRun.create({
      data: {
        runNumber: `RUN-CLAIM-${suffix}`,
        status: 'draft',
        totalMinor: 111_000,
        currencyCode: 'PHP',
        createdBy: actorId,
        lines: {
          create: [{ invoiceId, netMinor: 111_000, status: 'planned' }],
        },
      },
    })
    created.run.push(run.id)

    await expect(receipts.cancel(receiptId)).rejects.toThrow(
      /claimed by payment run/,
    )
    // The refused cancel changed nothing.
    expect(
      (await db.receipt.findUniqueOrThrow({ where: { id: receiptId } })).status,
    ).toBe('recorded')
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status,
    ).toBe('matched')

    // Once the run is voided the correction can proceed.
    await db.paymentRun.update({
      where: { id: run.id },
      data: { status: 'voided' },
    })
    await receipts.cancel(receiptId)
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status,
    ).toBe('received')
  })

  it('recovers shortfall exceptions when the remaining goods arrive', async () => {
    const po = await makePo('recover')
    const partial = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 5 }],
      recordedBy: actorId,
    })
    created.receipt.push((partial.receipt as { id: string }).id)

    const { invoice } = await registerInvoice(po.id, 'INV-RECOVER')
    const invoiceId = (invoice as { id: string }).id
    expect((invoice as { status: string }).status).toBe('exception')

    const rest = await receipts.record({
      poId: po.id,
      lines: [{ lineNo: 1, description: 'A4 bond paper', quantity: 5 }],
      recordedBy: actorId,
    })
    created.receipt.push((rest.receipt as { id: string }).id)
    expect(rest.rematch.matched).toBe(1)
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status,
    ).toBe('matched')
  })
})
