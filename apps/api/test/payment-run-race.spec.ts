import { ConflictException } from '@nestjs/common'
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
 * @workspace payment-run concurrency (§8.6) — claim checks and the run-number
 * mint now happen inside the transaction under FOR UPDATE row locks: two
 * concurrent creates for the same invoice cannot both succeed, and parallel
 * creates on disjoint invoices all get distinct run numbers.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actor = `finance-race-${suffix}`

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
const vendorService = new VendorService()
const receipts = new ReceiptService(
  new DocumentNumberService(),
  new EventEmitterService(),
  invoiceService,
)
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
  const prior = await policyService.latest('taxRule', false)
  const policy = await policyService.create({
    name: `Tax race ${suffix}`,
    kind: 'taxRule',
    updatedBy: actor,
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

async function makeMatchedInvoice(vendorId: string, tag: string) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-RACE-${tag}-${suffix}`,
      vendorId,
      status: 'issued',
      totalMinor: 100_000,
      issuedBy: actor,
      lines: {
        create: [
          {
            lineNo: 1,
            description: 'goods',
            quantity: 1,
            unitPriceMinor: 100_000,
            lineTotalMinor: 100_000,
          },
        ],
      },
    },
  })
  created.po.push(po.id)
  // §8.1 true three-way match: goods must arrive before an invoice matches.
  await receipts.record({
    poId: po.id,
    lines: [{ lineNo: 1, description: 'goods', quantity: 1 }],
    recordedBy: actor,
  })
  const invoice = await invoiceService.register({
    vendorId,
    number: `INV-RACE-${tag}-${suffix}`,
    poId: po.id,
    lines: [{ amountMinor: 100_000, class: 'goods' }],
  })
  created.invoice.push((invoice.invoice as { id: string }).id)
  expect((invoice.invoice as { status: string }).status).toBe('matched')
  return invoice.invoice as { id: string }
}

describe('Payment run concurrency (§8.6)', () => {
  it('only one concurrent create can claim an invoice', async () => {
    const vendor = await makeVendor('CLAIM')
    await vendorService.verifyBankAccount(vendor.id, {
      bank: 'BPI',
      holder: 'Race Co',
      accountNo: 'RACE1',
    })
    const invoice = await makeMatchedInvoice(vendor.id, 'claim')

    const results = await Promise.allSettled([
      paymentRuns.create({ invoiceIds: [invoice.id] }, actor),
      paymentRuns.create({ invoiceIds: [invoice.id] }, actor),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    if (fulfilled[0]?.status === 'fulfilled') {
      created.run.push(fulfilled[0].value.run.id)
    }
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConflictException)
    }
  })

  it('parallel creates on disjoint invoices get distinct run numbers', async () => {
    const vendor = await makeVendor('DISTINCT')
    await vendorService.verifyBankAccount(vendor.id, {
      bank: 'BPI',
      holder: 'Race Co',
      accountNo: 'RACE2',
    })
    const invoices = await Promise.all(
      ['d1', 'd2', 'd3', 'd4', 'd5'].map((tag) =>
        makeMatchedInvoice(vendor.id, tag),
      ),
    )

    const results = await Promise.all(
      invoices.map((invoice) =>
        paymentRuns.create({ invoiceIds: [invoice.id] }, actor),
      ),
    )

    expect(results.length).toBe(5)
    const numbers = results.map((r) => r.run.runNumber)
    expect(new Set(numbers).size).toBe(5)
    for (const result of results) created.run.push(result.run.id)
  })
})
