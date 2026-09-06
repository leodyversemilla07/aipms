import { BadRequestException, ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { ErpService } from '../src/erp/erp.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { PolicyService } from '../src/policy/policy.service'
import { ReceiptService } from '../src/receipt/receipt.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { VendorService } from '../src/vendor/vendor.service'

/**
 * Payment reservations and ERP dispatch (§8.5, §8.6):
 *
 * - claims are reservations: voided runs and terminally reconciled lines
 *   release their invoices for replacement runs; paid invoices never return;
 * - reconciliation is serialized per run with planned→terminal-only line
 *   transitions; concurrent closes cannot strand the run;
 * - ERP exports survive reconciliation as frozen artifacts, and settled
 *   pushes are refused before any second provider POST.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const maker = `maker-pr-${suffix}`
const checker = `checker-pr-${suffix}`

const created: Record<string, string[]> = {
  run: [],
  invoice: [],
  po: [],
  vendor: [],
  receipt: [],
  erpExport: [],
}

const numbers = new DocumentNumberService()
const events = new EventEmitterService()
const invoiceService = new InvoiceService(new PolicyService(), events)
const receipts = new ReceiptService(numbers, events, invoiceService)
const vendors = new VendorService()
const runs = new PaymentRunService(numbers)
const erp = new ErpService(events)

afterAll(async () => {
  await db.erpJournalExport.deleteMany({
    where: { id: { in: created.erpExport } },
  })
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.receipt.deleteMany({ where: { id: { in: created.receipt } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.$disconnect()
})

async function makeVendorBanked(tag: string) {
  const vendor = await db.vendor.create({
    data: { name: `PR Vendor ${tag} ${suffix}`, status: 'active' },
  })
  created.vendor.push(vendor.id)
  await vendors.verifyBankAccount(vendor.id, {
    bank: 'BDO',
    holder: `PR Vendor ${tag} ${suffix}`,
    accountNo: `pr-${tag}-${suffix}`.slice(0, 20),
  })
  return vendor
}

async function makeMatchedInvoice(vendorId: string, tag: string) {
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-PR-${tag}-${suffix}`,
      vendorId,
      status: 'issued',
      totalMinor: 100_000,
      issuedBy: maker,
      lines: {
        create: [
          {
            lineNo: 1,
            description: 'goods',
            quantity: 10,
            unitPriceMinor: 10_000,
            lineTotalMinor: 100_000,
          },
        ],
      },
    },
  })
  created.po.push(po.id)
  const { receipt } = await receipts.record({
    poId: po.id,
    lines: [{ lineNo: 1, description: 'goods', quantity: 10 }],
    recordedBy: maker,
  })
  created.receipt.push((receipt as { id: string }).id)
  const { invoice } = await invoiceService.register({
    vendorId,
    number: `INV-PR-${tag}-${suffix}`,
    poId: po.id,
    lines: [{ amountMinor: 100_000, class: 'goods' }],
  })
  created.invoice.push((invoice as { id: string }).id)
  expect((invoice as { status: string }).status).toBe('matched')
  return invoice as { id: string }
}

async function makeExecutedRun(invoiceIds: string[]) {
  const { run } = await runs.create({ invoiceIds }, maker)
  created.run.push(run.id)
  await runs.approve(run.id, checker)
  return runs.execute(run.id, checker)
}

describe('Claim release (§8.6 reservations)', () => {
  it('releases voided runs so a replacement run can proceed', async () => {
    const vendor = await makeVendorBanked('void')
    const inv = await makeMatchedInvoice(vendor.id, 'void')

    const first = await runs.create({ invoiceIds: [inv.id] }, maker)
    created.run.push(first.run.id)
    await expect(runs.create({ invoiceIds: [inv.id] }, maker)).rejects.toThrow(
      ConflictException,
    )

    await runs.voidRun(first.run.id)
    const replacement = await runs.create({ invoiceIds: [inv.id] }, maker)
    created.run.push(replacement.run.id)
    expect(replacement.run.status).toBe('draft')
  })

  it('releases dishonored lines but never paid invoices', async () => {
    const vendor = await makeVendorBanked('dish')
    const inv = await makeMatchedInvoice(vendor.id, 'dish')
    const executed = await makeExecutedRun([inv.id])
    const line = (await runs.detail(executed.id)).lines[0]
    if (!line) throw new Error('expected a line')

    await runs.reconcile(executed.id, line.id, 'dishonored')
    expect((await invoiceService.detail(inv.id)).status).toBe('matched')
    const replacement = await runs.create({ invoiceIds: [inv.id] }, maker)
    created.run.push(replacement.run.id)

    // A paid invoice is consumed permanently, not released.
    const vendor2 = await makeVendorBanked('paid')
    const inv2 = await makeMatchedInvoice(vendor2.id, 'paid')
    const executed2 = await makeExecutedRun([inv2.id])
    const line2 = (await runs.detail(executed2.id)).lines[0]
    if (!line2) throw new Error('expected a line')
    await runs.reconcile(executed2.id, line2.id, 'paid')
    await expect(runs.create({ invoiceIds: [inv2.id] }, maker)).rejects.toThrow(
      BadRequestException,
    )
  })
})

describe('Reconciliation terminal rules (§8.6)', () => {
  it('refuses to move an already decided line', async () => {
    const vendor = await makeVendorBanked('decided')
    const a = await makeMatchedInvoice(vendor.id, 'decided-a')
    const b = await makeMatchedInvoice(vendor.id, 'decided-b')
    const executed = await makeExecutedRun([a.id, b.id])
    const lines = (await runs.detail(executed.id)).lines
    const line = lines.find((l) => l.invoiceId === a.id)
    if (!line) throw new Error('expected a line')

    await runs.reconcile(executed.id, line.id, 'paid')
    await expect(
      runs.reconcile(executed.id, line.id, 'rejected'),
    ).rejects.toThrow(/already reconciled/)
    // The paid invoice was not rewritten by the refused transition.
    expect((await invoiceService.detail(a.id)).status).toBe('paid')
    expect((await runs.detail(executed.id)).status).toBe('executed')
  })

  it('closes the run exactly once under concurrent reconciliations', async () => {
    const vendor = await makeVendorBanked('conc')
    const a = await makeMatchedInvoice(vendor.id, 'conc-a')
    const b = await makeMatchedInvoice(vendor.id, 'conc-b')
    const executed = await makeExecutedRun([a.id, b.id])
    const lines = (await runs.detail(executed.id)).lines
    if (lines.length !== 2) throw new Error('expected two lines')

    const outcomes = await Promise.all(
      lines.map((line) => runs.reconcile(executed.id, line.id, 'paid')),
    )
    expect(outcomes).toHaveLength(2)
    expect((await runs.detail(executed.id)).status).toBe('reconciled')
  })
})

describe('ERP artifacts across reconciliation (§8.5)', () => {
  it('exports and reads manifests after the run reconciles', async () => {
    const vendor = await makeVendorBanked('erp')
    const inv = await makeMatchedInvoice(vendor.id, 'erp')
    const executed = await makeExecutedRun([inv.id])

    const first = await erp.exportRun(executed.id, 'finance-erp')
    created.erpExport.push(first.export.id)
    expect(first.created).toBe(true)

    const line = (await runs.detail(executed.id)).lines[0]
    if (!line) throw new Error('expected a line')
    await runs.reconcile(executed.id, line.id, 'paid')
    expect((await runs.detail(executed.id)).status).toBe('reconciled')

    // Export and manifest stay available once reconciled.
    const again = await erp.exportRun(executed.id, 'finance-erp')
    expect(again.created).toBe(false)
    expect(again.export.id).toBe(first.export.id)
    const viewed = await erp.manifest(first.export.id)
    expect(viewed.json).toBe(first.json)
  })

  it('serves the frozen artifact after master-data edits', async () => {
    const vendor = await makeVendorBanked('frozen')
    const inv = await makeMatchedInvoice(vendor.id, 'frozen')
    const executed = await makeExecutedRun([inv.id])
    const exported = await erp.exportRun(executed.id, 'finance-erp')
    created.erpExport.push(exported.export.id)

    await db.vendor.update({
      where: { id: vendor.id },
      data: { name: `Renamed ${suffix}`, taxId: '000-000-000-000' },
    })
    const viewed = await erp.manifest(exported.export.id)
    expect(viewed.json).toBe(exported.json)
    expect(viewed.json).toContain(`PR Vendor frozen ${suffix}`)
  })

  it('refuses a second push once the export settles, before any POST', async () => {
    const vendor = await makeVendorBanked('push')
    const inv = await makeMatchedInvoice(vendor.id, 'push')
    const executed = await makeExecutedRun([inv.id])
    const exported = await erp.exportRun(executed.id, 'finance-erp')
    created.erpExport.push(exported.export.id)

    const ready = await erp.prepareQboPush(exported.export.id)
    expect(typeof ready.json).toBe('string')

    await erp.acknowledge({
      exportId: exported.export.id,
      status: 'posted',
      externalRef: 'QB-JE-1',
    })
    await expect(erp.prepareQboPush(exported.export.id)).rejects.toThrow(
      /already posted/,
    )
  })
})
