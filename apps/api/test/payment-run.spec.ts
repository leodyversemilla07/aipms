import { BadRequestException, ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { PolicyService } from '../src/policy/policy.service'
import { ReceiptService } from '../src/receipt/receipt.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { VendorService } from '../src/vendor/vendor.service'

/**
 * @workspace payment-run service — §8.6 approved payment run (hand-off to
 * finance): deterministic net sums, maker/checker approval, beneficiary
 * bank control, and reconciliation. Against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorA = `finance-a-${suffix}`
const actorB = `finance-b-${suffix}`

const created: Record<string, string[]> = {
  run: [],
  invoice: [],
  po: [],
  vendor: [],
  policy: [],
}

const policyService = new PolicyService()
const invoiceService = new InvoiceService(
  policyService,
  new EventEmitterService(),
)

const receipts = new ReceiptService(
  new DocumentNumberService(),
  new EventEmitterService(),
  invoiceService,
)
const vendorService = new VendorService()
const paymentRuns = new PaymentRunService(new DocumentNumberService())

afterAll(async () => {
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.receipt.deleteMany({ where: { poId: { in: created.po } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.$disconnect()
})

beforeAll(async () => {
  // Pin the tax policy this spec asserts against (goods 1% / services 2%),
  // superseding whatever another spec left as "latest" so resolution is
  // deterministic (§8.4 config-over-fork).
  const prior = await policyService.latest('taxRule', false)
  const policy = await policyService.create({
    name: `Tax default ${suffix}`,
    kind: 'taxRule',
    updatedBy: actorA,
    config: { vatRateBps: 1200, ewtRatesBps: { goods: 100, services: 200 } },
    supersedesId: prior?.id ?? null,
  })
  created.policy.push(policy.id)
})

async function makeVendor(name: string) {
  const vendor = await db.vendor.create({
    data: { name, status: 'active', taxId: `TAX-${name}-${suffix}` },
  })
  created.vendor.push(vendor.id)
  return vendor
}

async function makePo(vendorId: string, totalMinor: number, tag: string) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-PR-${tag}-${suffix}`,
      vendorId,
      status: 'issued',
      totalMinor,
      issuedBy: actorA,
      lines: {
        create: [
          {
            lineNo: 1,
            description: 'goods',
            quantity: 1,
            unitPriceMinor: totalMinor,
            lineTotalMinor: totalMinor,
          },
        ],
      },
    },
  })
  created.po.push(po.id)
  return po
}

async function verify(vendorId: string, accountNo: string) {
  return vendorService.verifyBankAccount(vendorId, {
    bank: 'BPI',
    holder: 'Test Co',
    accountNo,
  })
}

async function makeMatchedInvoice(
  vendorId: string,
  lines: { amountMinor: number; class: 'goods' | 'services' }[],
  tag: string,
) {
  const gross = lines.reduce((sum, line) => sum + line.amountMinor, 0)
  const po = await makePo(vendorId, gross, tag)
  // §8.1 true three-way match: goods must arrive before an invoice matches.
  await receipts.record({
    poId: po.id,
    lines: [{ lineNo: 1, description: 'goods', quantity: 1 }],
    recordedBy: actorA,
  })
  const invoice = await invoiceService.register({
    vendorId,
    number: `INV-P8-${tag}-${suffix}`,
    poId: (
      await db.purchaseOrder.findFirst({
        where: { poNumber: `PO-PR-${tag}-${suffix}` },
      })
    )?.id,
    lines,
  })
  created.invoice.push((invoice.invoice as { id: string }).id)
  expect((invoice.invoice as { status: string }).status).toBe('matched')
  return invoice.invoice as {
    id: string
    amountMinor: number
    vatMinor: number
    ewtMinor: number
  }
}

const goodsLine = { amountMinor: 200_000, class: 'goods' as const } // VAT 12%, EWT 1%
const serviceLine = { amountMinor: 100_000, class: 'services' as const } // VAT 12%, EWT 2%

describe('Payment run — deterministic totals (§8.6)', () => {
  it('sums net = gross + VAT − EWT deterministically', async () => {
    const vendor = await makeVendor('TOTAL')
    await verify(vendor.id, '0001')

    const a = await makeMatchedInvoice(vendor.id, [goodsLine], 'tot-a')
    const b = await makeMatchedInvoice(vendor.id, [serviceLine], 'tot-b')
    // a net = 200000 + 24000 − 2000 = 222000
    // b net = 100000 + 12000 − 2000 = 110000
    const expected = 200_000 + 24_000 - 2_000 + (100_000 + 12_000 - 2_000)

    const { run, netMinor } = await paymentRuns.create(
      { invoiceIds: [a.id, b.id] },
      actorA,
    )
    created.run.push(run.id)

    expect(netMinor).toBe(expected)
    expect(run.totalMinor).toBe(expected)
    expect(run.lines.length).toBe(2)
    expect(run.status).toBe('draft')
  })
})

describe('Maker/checker approval (§16.4)', () => {
  it('requires a different approver than the creator', async () => {
    const vendor = await makeVendor('MC')
    await verify(vendor.id, 'A2')
    const inv = await makeMatchedInvoice(vendor.id, [goodsLine], 'mc')

    const { run } = await paymentRuns.create({ invoiceIds: [inv.id] }, actorA)
    created.run.push(run.id)

    await expect(paymentRuns.approve(run.id, actorA)).rejects.toBeInstanceOf(
      BadRequestException,
    )

    const approved = await paymentRuns.approve(run.id, actorB)
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe(actorB)

    const executed = await paymentRuns.execute(run.id, actorB)
    expect(executed.status).toBe('executed')
  })
})

describe('§8.6 beneficiary bank control', () => {
  it('refuses a run with an unverified bank account', async () => {
    const vendor = await makeVendor('UNV') // never verified
    const inv = await makeMatchedInvoice(vendor.id, [goodsLine], 'unv')

    await expect(
      paymentRuns.create({ invoiceIds: [inv.id] }, actorA),
    ).rejects.toThrow(/Unverified beneficiary/)
  })

  it('re-verifies after a bank account change', async () => {
    const vendor = await makeVendor('CHG')
    await verify(vendor.id, 'C1')
    const inv = await makeMatchedInvoice(vendor.id, [goodsLine], 'chg')

    // change the account → flagged as changed → refused
    await verify(vendor.id, 'C2')
    const changed = await db.vendor.findUnique({ where: { id: vendor.id } })
    expect(changed?.bankAccountChangedAt).not.toBeNull()
    await expect(
      paymentRuns.create({ invoiceIds: [inv.id] }, actorA),
    ).rejects.toThrow(BadRequestException)

    // re-verify with the same account clears the change stamp
    await verify(vendor.id, 'C2')
    const { run } = await paymentRuns.create({ invoiceIds: [inv.id] }, actorA)
    created.run.push(run.id)
    expect(run.status).toBe('draft')
  })
})

describe('Reconciliation (§8.6)', () => {
  it('settles to reconciled only when every line reconciles', async () => {
    const vendor = await makeVendor('REC')
    await verify(vendor.id, 'R1')
    const a = await makeMatchedInvoice(vendor.id, [goodsLine], 're-a')
    const b = await makeMatchedInvoice(vendor.id, [serviceLine], 're-b')

    const { run } = await paymentRuns.create(
      { invoiceIds: [a.id, b.id] },
      actorA,
    )
    created.run.push(run.id)
    await paymentRuns.approve(run.id, actorB)
    await paymentRuns.execute(run.id, actorB)

    const detail = await paymentRuns.detail(run.id)
    const lineA = detail.lines.find((line) => line.invoiceId === a.id)
    const lineB = detail.lines.find((line) => line.invoiceId === b.id)
    if (!lineA || !lineB) throw new Error('expected both lines')

    await paymentRuns.reconcile(run.id, lineA.id, 'paid')
    expect((await paymentRuns.detail(run.id)).status).toBe('executed')
    expect((await invoiceService.detail(a.id)).status).toBe('paid')

    await paymentRuns.reconcile(run.id, lineB.id, 'dishonored')
    const closed = await paymentRuns.detail(run.id)
    expect(closed.status).toBe('reconciled')
    expect((await invoiceService.detail(b.id)).status).toBe('matched')
  })

  it('blocks double planning of the same invoice', async () => {
    const vendor = await makeVendor('DUP')
    await verify(vendor.id, 'D1')
    const inv = await makeMatchedInvoice(vendor.id, [goodsLine], 'dup')

    const { run } = await paymentRuns.create({ invoiceIds: [inv.id] }, actorA)
    created.run.push(run.id)

    await expect(
      paymentRuns.create({ invoiceIds: [inv.id] }, actorA),
    ).rejects.toThrow(ConflictException)
  })
})
