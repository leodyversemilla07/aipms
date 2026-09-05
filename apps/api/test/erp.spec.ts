import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ErpService } from '../src/erp/erp.service'
import type { JournalManifest } from '../src/erp/journal'
import {
  buildJournalManifest,
  manifestHash,
  manifestToCsv,
  verifyBalanced,
} from '../src/erp/journal'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

const created = {
  vendor: [] as string[],
  invoice: [] as string[],
  run: [] as string[],
  erpExport: [] as string[],
}

const events = new EventEmitterService()
const numbers = new DocumentNumberService()
const invoices = new InvoiceService(
  new (class {
    async taxConfig() {
      return {
        vatRateBps: 1200,
        ewtRatesBps: { goods: 100 },
        version: 'ph-v1',
      }
    }
  })() as never,
  events,
)
const runs = new PaymentRunService(numbers)
let erp: ErpService

afterAll(async () => {
  await db.erpJournalExport.deleteMany({
    where: { id: { in: created.erpExport } },
  })
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
})

beforeEach(() => {
  erp = new ErpService(events)
})

async function makeExecutedRun(tag: string) {
  const suffix = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const vendor = await db.vendor.create({
    data: {
      name: `ERP Vendor ${suffix}`,
      status: 'active',
      taxId: `000-erp-${suffix}`,
      // §8.6 beneficiary control: a run will not plan unverified vendors.
      bankAccount: {
        bank: 'BDO',
        accountNumber: suffix,
        holder: `ERP Vendor ${suffix}`,
      },
      bankAccountVerifiedAt: new Date(),
      // Fresh account = verified at creation; a *change* would force
      // re-verification (§8.6), so changedAt stays null.
      bankAccountChangedAt: null,
    },
  })
  created.vendor.push(vendor.id)

  const { invoice } = await invoices.register({
    vendorId: vendor.id,
    number: `ERP-INV-${suffix}`,
    lines: [{ amountMinor: 100_000, class: 'goods' as const }],
  })
  const inv = invoice as { id: string }
  created.invoice.push(inv.id)
  await db.invoice.update({
    where: { id: inv.id },
    data: { status: 'matched' },
  })

  const { run } = await runs.create({ invoiceIds: [inv.id] }, 'maker-erp')
  created.run.push(run.id)
  await runs.approve(run.id, 'checker-erp')
  await runs.execute(run.id, 'maker-erp')
  return { vendor, runId: run.id, invoiceId: inv.id }
}

describe('journal manifest (pure §8.5 builder)', () => {
  it('builds a balanced journal with the §8.4 tax split', () => {
    const manifest = buildJournalManifest({
      runNumber: 'PR-TEST',
      executedAt: new Date('2026-08-23T00:00:00Z'),
      currencyCode: 'PHP',
      invoices: [
        {
          invoiceId: 'i1',
          invoiceNumber: 'INV-1',
          vendorName: 'Acme',
          vendorTaxId: '000-123',
          amountMinor: 100_000,
          vatMinor: 12_000,
          ewtMinor: 5_000,
        },
      ],
    })

    expect(manifest.totalMinor).toBe(107_000) // net funded
    expect(verifyBalanced(manifest).balanced).toBe(true)

    const ap = manifest.entries.find((e) => e.account === '2010')
    const ewt = manifest.entries.find((e) => e.account === '2020')
    const cash = manifest.entries.find((e) => e.account === '1010')
    expect(ap?.side).toBe('debit')
    expect(ap?.amountMinor).toBe(112_000)
    expect(ewt?.amountMinor).toBe(5_000)
    expect(cash?.amountMinor).toBe(107_000)
  })

  it('is deterministic — same input yields the same hash', () => {
    const build = () =>
      buildJournalManifest({
        runNumber: 'PR-TEST',
        executedAt: new Date('2026-08-23T00:00:00Z'),
        currencyCode: 'PHP',
        invoices: [],
      })
    expect(manifestHash(JSON.stringify(build()))).toBe(
      manifestHash(JSON.stringify(build())),
    )
  })

  it('serializes to importable CSV with escaping', () => {
    const manifest: JournalManifest = buildJournalManifest({
      runNumber: 'PR-CSV',
      executedAt: new Date(),
      currencyCode: 'PHP',
      invoices: [
        {
          invoiceId: 'i9',
          invoiceNumber: 'INV,9',
          vendorName: 'Quote "Co"',
          vendorTaxId: null,
          amountMinor: 10_000,
          vatMinor: 0,
          ewtMinor: 0,
        },
      ],
    })
    const csv = manifestToCsv(manifest)
    expect(csv).toContain('# run=PR-CSV')
    expect(csv).toContain('"INV,9"')
    expect(csv).toContain('"Quote ""Co"""')
    expect(csv.trimEnd().split('\n').length).toBe(4) // comment + header + 2 entries
  })
})

describe('ErpService', () => {
  it('exports an executed run once; re-export is idempotent', async () => {
    const { runId } = await makeExecutedRun('idem')
    const first = await erp.exportRun(runId, 'smoke-finance')
    expect(first.created).toBe(true)
    created.erpExport.push(first.export.id)

    const second = await erp.exportRun(runId, 'smoke-finance')
    expect(second.created).toBe(false)
    expect(second.export.id).toBe(first.export.id)
    expect(second.hash).toBe(first.hash)
  })

  it('refuses to export a non-executed run', async () => {
    const vendor = await db.vendor.create({
      data: {
        name: `Draft-only ${Date.now()}`,
        status: 'active',
        bankAccount: {
          bank: 'BDO',
          accountNumber: 'draft',
          holder: 'Draft-only Co',
        },
        bankAccountVerifiedAt: new Date(),
        bankAccountChangedAt: null,
      },
    })
    created.vendor.push(vendor.id)
    const { invoice } = await invoices.register({
      vendorId: vendor.id,
      number: `DRAFT-${Date.now()}`,
      lines: [{ amountMinor: 50_000, class: 'goods' as const }],
    })
    const inv = invoice as { id: string }
    created.invoice.push(inv.id)
    await db.invoice.update({
      where: { id: inv.id },
      data: { status: 'matched' },
    })
    const { run } = await runs.create({ invoiceIds: [inv.id] }, 'maker-erp')
    created.run.push(run.id)

    await expect(erp.exportRun(run.id, 'smoke-finance')).rejects.toThrow(
      /draft/,
    )
  })

  it('acknowledges posted and rejected; rejection needs a reason', async () => {
    const { runId } = await makeExecutedRun('ack')
    const { export: exp } = await erp.exportRun(runId, 'smoke-finance')
    created.erpExport.push(exp.id)

    await expect(
      erp.acknowledge({
        exportId: exp.id,
        status: 'rejected',
        rejectedReason: null,
      }),
    ).rejects.toThrow(/reason/i)

    const posted = await erp.acknowledge({
      exportId: exp.id,
      status: 'posted',
      externalRef: 'QB-JE-991',
    })
    expect(posted.status).toBe('posted')

    await expect(
      erp.acknowledge({ exportId: exp.id, status: 'rejected' }),
    ).rejects.toThrow(/already posted/)
  })

  it('ingests vendor master registrations by taxId without duplicating', async () => {
    const taxId = `999-ingest-${Date.now()}`
    const first = await erp.ingestVendors([
      {
        name: 'Ingested Supplier Co',
        taxId,
        email: 'ap@supplier.example',
        paymentTermsDays: 45,
      },
    ])
    expect(first.created).toBe(1)

    const again = await erp.ingestVendors([
      { name: 'Ingested Supplier Co (renamed)', taxId },
    ])
    expect(again.created).toBe(0)
    expect(again.updated).toBe(1)

    const rows = await db.vendor.findMany({ where: { taxId } })
    expect(rows.length).toBe(1)
    expect(rows[0]?.name).toBe('Ingested Supplier Co (renamed)')
    created.vendor.push(...rows.map((r) => r.id))
  })

  it('reports reconciliation gaps', async () => {
    const report = await erp.reconcileReport()
    expect(report).toHaveProperty('missingExports')
    expect(report).toHaveProperty('awaitingAcknowledgement')
    expect(typeof report.clean).toBe('boolean')

    // An executed-but-unexported run must appear in missingExports.
    const { runId } = await makeExecutedRun('gap')
    const after = await erp.reconcileReport()
    expect(
      after.missingExports.some((m: { runId: string }) => m.runId === runId),
    ).toBe(true)
  })
})
