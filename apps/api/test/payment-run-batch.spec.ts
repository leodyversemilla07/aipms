import { BadRequestException, ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPaymentBatch, parseBeneficiary } from '../src/payment-run/batch'
import {
  buildPain001,
  formatAmount,
  resolveDebtor,
} from '../src/payment-run/pain001'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'

/**
 * §8.6 payment batch file — the normalized PESONet hand-off artifact.
 * Pure builder tests run offline; the integration section drives a real
 * approved run through PaymentRunService.generateBatch against local
 * Postgres and asserts determinism + tamper-evidence.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorA = `finance-a-${suffix}`
const actorB = `finance-b-${suffix}`

const created: Record<string, string[]> = { run: [], invoice: [], vendor: [] }

const runs = new PaymentRunService(new DocumentNumberService())

afterAll(async () => {
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.$disconnect()
})

const baseLine = {
  lineId: `line-${suffix}-1`,
  invoiceId: 'inv-1',
  invoiceNumber: 'INV-1',
  vendorId: 'v-1',
  vendorName: 'Acme',
  vendorTaxId: 'TAX-1',
  netMinor: 100_000,
  currencyCode: 'PHP',
  bankAccount: {
    bank: 'BPI',
    accountNumber: '1234567890',
    holder: 'Acme Inc',
  },
}

describe('batch builder (§8.6, pure)', () => {
  it('normalizes both stored bankAccount shapes', () => {
    expect(
      parseBeneficiary({ bank: 'BDO', accountNumber: '111', holder: 'A' }),
    ).toEqual({
      bank: 'BDO',
      accountNumber: '111',
      holder: 'A',
    })
    // legacy test/tooling shape uses accountNo
    expect(
      parseBeneficiary({ bank: 'BDO', accountNo: '222', holder: 'B' })
        ?.accountNumber,
    ).toBe('222')
    expect(parseBeneficiary(null)).toBeNull()
    expect(parseBeneficiary({ bank: 'BDO', holder: 'C' })).toBeNull() // no account number
    expect(parseBeneficiary('not-an-object')).toBeNull()
  })

  it('builds a deterministic manifest sorted by invoice number', () => {
    const lines = [
      baseLine,
      {
        ...baseLine,
        lineId: 'line-2',
        invoiceId: 'inv-2',
        invoiceNumber: 'INV-0',
        netMinor: 50_000,
      },
    ]
    const first = buildPaymentBatch({
      runNumber: `RUN-${suffix}`,
      executedAt: new Date('2026-01-01T00:00:00Z'),
      currencyCode: 'PHP',
      totalMinor: 150_000,
      lines,
    })
    const second = buildPaymentBatch({
      runNumber: `RUN-${suffix}`,
      executedAt: new Date('2026-01-01T00:00:00Z'),
      currencyCode: 'PHP',
      totalMinor: 150_000,
      lines: [...lines].reverse(),
    })
    expect(first.sha256).toBe(second.sha256)
    expect(first.json).toBe(second.json)
    expect(first.manifest.credits[0].invoiceNumber).toBe('INV-0')
    expect(first.manifest.totalMinor).toBe(150_000)
    expect(first.manifest.lineCount).toBe(2)
    expect(first.manifest.rail).toBe('pesonet')
  })

  it('refuses the whole batch when any beneficiary is unusable (all-or-nothing)', () => {
    expect(() =>
      buildPaymentBatch({
        runNumber: `RUN-${suffix}`,
        executedAt: new Date(),
        currencyCode: 'PHP',
        totalMinor: 150_000,
        lines: [
          baseLine,
          {
            ...baseLine,
            lineId: 'line-2',
            invoiceNumber: 'INV-2',
            bankAccount: null,
          },
        ],
      }),
    ).toThrow(/Unusable beneficiaries.*INV-2/)
  })

  it('refuses a batch whose lines do not sum to the frozen run total', () => {
    expect(() =>
      buildPaymentBatch({
        runNumber: `RUN-${suffix}`,
        executedAt: new Date(),
        currencyCode: 'PHP',
        totalMinor: 999,
        lines: [baseLine],
      }),
    ).toThrow(/does not balance/)
  })

  it('emits a flat CSV with escaped cells', () => {
    const built = buildPaymentBatch({
      runNumber: `RUN-${suffix}`,
      executedAt: new Date('2026-01-01T00:00:00Z'),
      currencyCode: 'PHP',
      totalMinor: 100_000,
      lines: [{ ...baseLine, vendorName: 'Acme, Inc.' }],
    })
    const csvRows = built.csv.split('\n')
    expect(csvRows[1]).toBe(
      'lineId,invoiceNumber,vendorName,beneficiaryBank,beneficiaryAccountNumber,beneficiaryHolder,amountMinor,currencyCode,memo',
    )
    expect(csvRows[2]).toContain('"Acme, Inc."')
    expect(built.csv.endsWith('\n')).toBe(true)
  })
})

describe('pain.001 emitter (§8.6, pure)', () => {
  const manifest = buildPaymentBatch({
    runNumber: `RUN-${suffix}`,
    executedAt: new Date('2026-01-01T00:00:00Z'),
    currencyCode: 'PHP',
    totalMinor: 100_000,
    lines: [{ ...baseLine, vendorName: 'Acme & Sons <Ltd>' }],
  }).manifest
  const debtor = { name: 'Buyer Org', accountNumber: '990011' }

  it('formats minor units as two-decimal amounts and rejects non-integers', () => {
    expect(formatAmount(123_456)).toBe('1234.56')
    expect(formatAmount(5)).toBe('0.05')
    expect(formatAmount(-200)).toBe('-2.00')
    expect(() => formatAmount(1.5)).toThrow(/safe integer/)
  })

  it('renders a standards-shaped document with escaped beneficiary text', () => {
    const { xml } = buildPain001(manifest, debtor)
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.08')
    expect(xml).toContain('<PmtMtd>TRF</PmtMtd>')
    expect(xml).toContain('<CtrlSum>1000.00</CtrlSum>')
    expect(xml).toContain('<NbOfTxs>1</NbOfTxs>')
    // XML escaping of vendor-sourced names
    expect(xml).toContain('Acme &amp; Sons &lt;Ltd&gt;')
    expect(xml).not.toContain('Acme & Sons <Ltd>')
    // EndToEndId ties the credit back to the run + invoice
    expect(xml).toContain(`<EndToEndId>RUN-${suffix}-INV-1</EndToEndId>`)
  })

  it('is deterministic for the same manifest', () => {
    const first = buildPain001(manifest, debtor)
    const second = buildPain001(manifest, debtor)
    expect(first.xml).toBe(second.xml)
    expect(first.sha256).toBe(second.sha256)
  })

  it('resolves the debtor only when both name and account are configured', () => {
    const env = { AIPMS_PAYMENT_DEBTOR_NAME: 'Org' }
    expect(resolveDebtor(env)).toBeNull()
    expect(
      resolveDebtor({ ...env, AIPMS_PAYMENT_DEBTOR_ACCOUNT: '12345' }),
    ).toEqual({ name: 'Org', accountNumber: '12345' })
  })
})

describe('generateBatch integration (approved run hand-off)', () => {
  it('produces a deterministic batch for an approved run and refuses drafts', async () => {
    const vendor = await db.vendor.create({
      data: {
        name: `Batch Vendor ${suffix}`,
        status: 'active',
        taxId: `TAX-BATCH-${suffix}`,
        bankAccount: {
          bank: 'BDO',
          accountNumber: suffix,
          holder: 'Batch Vendor Co',
        },
        bankAccountVerifiedAt: new Date(),
        bankAccountChangedAt: null,
      },
    })
    created.vendor.push(vendor.id)

    const invoice = await db.invoice.create({
      data: {
        vendorId: vendor.id,
        poId: null,
        number: `INV-BATCH-${suffix}`,
        amountMinor: 200_000,
        vatMinor: 24_000,
        ewtMinor: 2_000,
        status: 'matched',
      },
    })
    created.invoice.push(invoice.id)

    const made = await runs.create({ invoiceIds: [invoice.id] }, actorA)
    created.run.push(made.run.id)
    const runId = made.run.id

    // Drafts are not binding — no batch before approval.
    await expect(runs.generateBatch(runId)).rejects.toBeInstanceOf(
      ConflictException,
    )

    await runs.approve(runId, actorB)
    const batch = await runs.generateBatch(runId)

    expect(batch.runNumber).toBe(made.run.runNumber)
    expect(batch.lineCount).toBe(1)
    expect(batch.totalMinor).toBe(222_000) // gross + VAT − EWT
    expect(batch.json).toContain(`"runNumber":"${made.run.runNumber}"`)
    expect(batch.csv).toContain(suffix)

    // pain.001 rides the same frozen data when the debtor is configured.
    process.env.AIPMS_PAYMENT_DEBTOR_NAME = `Batch Buyer ${suffix}`
    process.env.AIPMS_PAYMENT_DEBTOR_ACCOUNT = '990011'
    try {
      const withDebtor = await runs.generateBatch(runId)
      expect(withDebtor.pain001).toBeTruthy()
      if (!withDebtor.pain001)
        throw new Error('expected pain.001 to be emitted')
      expect(withDebtor.pain001).toContain('<CtrlSum>2220.00</CtrlSum>')
    } finally {
      delete process.env.AIPMS_PAYMENT_DEBTOR_NAME
      delete process.env.AIPMS_PAYMENT_DEBTOR_ACCOUNT
    }

    // Deterministic regeneration → identical sha256.
    const again = await runs.generateBatch(runId)
    expect(again.sha256).toBe(batch.sha256)
    expect(again.json).toBe(batch.json)
  })

  it('refuses generation when the vendor master lost its bank account', async () => {
    const vendor = await db.vendor.create({
      data: { name: `NoBank ${suffix}`, status: 'active' },
    })
    created.vendor.push(vendor.id)
    const invoice = await db.invoice.create({
      data: {
        vendorId: vendor.id,
        number: `INV-NOBANK-${suffix}`,
        amountMinor: 10_000,
        status: 'matched',
      },
    })
    created.invoice.push(invoice.id)

    // create() would refuse unverified banks; simulate a verified account that
    // was wiped after compose (data drift must fail visible, §13).
    const made = await db.paymentRun.create({
      data: {
        runNumber: `RUN-NB-${suffix}`,
        status: 'approved',
        totalMinor: 10_000,
        createdBy: actorA,
        approvedBy: actorB,
        lines: { create: { invoiceId: invoice.id, netMinor: 10_000 } },
      },
    })
    created.run.push(made.id)

    await expect(runs.generateBatch(made.id)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })
})
