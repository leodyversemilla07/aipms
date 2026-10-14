import './no-database'
import type { InvoiceStatus, Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceService } from '../../src/invoice/invoice.service'
import type { PolicyService } from '../../src/policy/policy.service'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'

interface InvoiceRecord {
  id: string
  poId: string | null
  vendorId: string
  number: string
  amountMinor: number
  vatMinor: number
  ewtMinor: number
  currencyCode: string
  status: InvoiceStatus
  matchResult: unknown
  receivedAt: Date
}

interface ReceiptLineRecord {
  quantity: number
  lineNo: number | null
}

interface ReceiptRecord {
  id: string
  poId: string
  status: string
  lines: ReceiptLineRecord[]
}

interface PoLineRecord {
  lineNo: number
  unitPriceMinor: number
}

function fixture(poTerms: Record<string, unknown> | null = null) {
  const state = {
    po: {
      id: 'po-1',
      poNumber: 'PO-2026-0001',
      vendorId: 'vendor-1',
      status: 'confirmed' as const,
      currencyCode: 'PHP',
      totalMinor: 100_000,
      terms: poTerms,
      issuedBy: 'buyer-1',
      issuedAt: new Date(),
    },
    poLines: [{ lineNo: 1, unitPriceMinor: 10_000 }] as PoLineRecord[],
    receipts: [
      {
        id: 'rec-1',
        poId: 'po-1',
        status: 'recorded',
        lines: [{ quantity: 10, lineNo: 1 }],
      },
    ] as ReceiptRecord[],
    invoices: [] as InvoiceRecord[],
  }

  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventEmitterService

  const policy = {
    taxConfig: vi.fn().mockResolvedValue({
      vatRateBps: 1200,
      ewtRatesBps: {
        goods: 100,
        services: 200,
        professional: 500,
        rental: 500,
        other: 0,
      },
      version: 'ph-v1',
    }),
  } as unknown as PolicyService

  const client = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    purchaseOrder: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return where.id === state.po.id ? state.po : null
      }),
    },
    purchaseOrderLine: {
      findMany: vi.fn(async ({ where }: { where: { poId: string } }) => {
        return where.poId === state.po.id ? state.poLines : []
      }),
    },
    receipt: {
      findMany: vi.fn(
        async ({ where }: { where: { poId: string; status: string } }) => {
          return state.receipts.filter(
            (r) => r.poId === where.poId && r.status === where.status,
          )
        },
      ),
    },
    invoice: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where:
            | { id: string }
            | { vendorId_number: { vendorId: string; number: string } }
        }) => {
          if ('id' in where) {
            return state.invoices.find((inv) => inv.id === where.id) ?? null
          }
          return (
            state.invoices.find(
              (inv) =>
                inv.vendorId === where.vendorId_number.vendorId &&
                inv.number === where.vendorId_number.number,
            ) ?? null
          )
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            poId?: string
            status?: { in?: string[] } | string
            id?: { not?: string }
            OR?: Array<{ status?: string; matchResult?: unknown }>
          }
        }) => {
          return state.invoices.filter((inv) => {
            if (where.poId && inv.poId !== where.poId) return false
            if (where.id?.not && inv.id === where.id.not) return false
            if (
              where.status &&
              typeof where.status === 'object' &&
              where.status.in
            ) {
              return where.status.in.includes(inv.status)
            }
            if (where.OR) {
              return where.OR.some((clause) => {
                if (clause.status === 'received' && inv.status === 'received') {
                  return true
                }
                if (
                  clause.status === 'exception' &&
                  inv.status === 'exception' &&
                  (inv.matchResult as { outcome?: string })?.outcome ===
                    'receipt_shortfall'
                ) {
                  return true
                }
                return false
              })
            }
            return true
          })
        },
      ),
      create: vi.fn(async ({ data }: { data: Prisma.InvoiceCreateInput }) => {
        const row: InvoiceRecord = {
          id: `inv-${state.invoices.length + 1}`,
          poId: (data.poId as string) ?? null,
          vendorId: data.vendorId as string,
          number: data.number,
          amountMinor: data.amountMinor,
          vatMinor: data.vatMinor,
          ewtMinor: data.ewtMinor,
          currencyCode: data.currencyCode ?? 'PHP',
          status: data.status,
          matchResult: data.matchResult ?? null,
          receivedAt: (data.receivedAt as Date) ?? new Date(),
        }
        state.invoices.push(row)
        return row
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Partial<InvoiceRecord>
        }) => {
          const row = state.invoices.find((inv) => inv.id === where.id)
          if (!row) throw new Error(`Invoice ${where.id} not found in fixture`)
          Object.assign(row, data)
          return row
        },
      ),
    },
    paymentRunLine: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  }

  const service = new InvoiceService(policy, events)

  return { state, service, client, events }
}

describe('Milestone / Partial Invoicing Support (Finding 336)', () => {
  it('rejects partial invoices when partial billing is not permitted (standard PO)', async () => {
    const { service, client } = fixture() // no milestone terms on PO

    const result = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-1',
        poId: 'po-1',
        lines: [{ amountMinor: 40_000, class: 'goods' }],
        // allowPartial not set
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((result.invoice as InvoiceRecord).status).toBe('exception')
    expect(result.match).toMatchObject({
      outcome: 'amount_mismatch',
      amountMatched: false,
      isPartial: false,
    })
  })

  it('rejects over-billing invoices even if allowPartial is requested', async () => {
    const { service, client } = fixture()

    const result = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-OVER',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 120_000, class: 'goods' }], // Exceeds PO total 100k
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((result.invoice as InvoiceRecord).status).toBe('exception')
    expect(result.match).toMatchObject({
      outcome: 'amount_mismatch',
      amountMatched: false,
    })
  })

  it('matches sequential 2-stage milestone invoices up to total PO capacity', async () => {
    const { service, client } = fixture()

    // Stage 1: 40,000 PHP out of 100,000 PHP PO
    const first = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-1',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 40_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((first.invoice as InvoiceRecord).status).toBe('matched')
    expect(first.match).toMatchObject({
      outcome: 'matched',
      amountMatched: true,
      isPartial: true,
      allocatedMinor: 0,
      receivedValueMinor: 100_000,
      poRemainingMinor: 60_000,
    })

    // Stage 2: remaining 60,000 PHP out of 100,000 PHP PO
    const second = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-2',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 60_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((second.invoice as InvoiceRecord).status).toBe('matched')
    expect(second.match).toMatchObject({
      outcome: 'matched',
      amountMatched: true,
      isPartial: true,
      allocatedMinor: 40_000,
      receivedValueMinor: 100_000,
      poRemainingMinor: 0,
    })

    // Stage 3: subsequent invoice attempts to bill another 10,000 PHP
    const third = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-3',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 10_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((third.invoice as InvoiceRecord).status).toBe('exception')
    expect(third.match).toMatchObject({
      outcome: 'over_allocated',
      allocatedMinor: 100_000,
    })
  })

  it('automatically supports partial invoicing when PO terms declare milestone billing', async () => {
    const { service, client } = fixture({ billingType: 'milestone' })

    // No explicit allowPartial in registration input
    const result = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-MILESTONE-1',
        poId: 'po-1',
        lines: [{ amountMinor: 50_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((result.invoice as InvoiceRecord).status).toBe('matched')
    expect(result.match).toMatchObject({
      outcome: 'matched',
      amountMatched: true,
      isPartial: true,
      poRemainingMinor: 50_000,
    })
  })

  it('returns awaiting_receipt when no goods have been recorded for milestone invoice', async () => {
    const { service, client, state } = fixture()
    state.receipts = [] // No receipts recorded yet

    const result = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-NO-GOODS',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 40_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((result.invoice as InvoiceRecord).status).toBe('received')
    expect(result.match).toMatchObject({
      outcome: 'awaiting_receipt',
      receivedValueMinor: 0,
      isPartial: true,
    })
  })

  it('returns receipt_shortfall when milestone invoice exceeds recorded receipts', async () => {
    const { service, client, state } = fixture()
    // Only 3 units received = 30,000 PHP, but invoice is 40,000 PHP
    state.receipts = [
      {
        id: 'rec-partial',
        poId: 'po-1',
        status: 'recorded',
        lines: [{ quantity: 3, lineNo: 1 }],
      },
    ]

    const result = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-SHORT',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 40_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )

    expect((result.invoice as InvoiceRecord).status).toBe('exception')
    expect(result.match).toMatchObject({
      outcome: 'receipt_shortfall',
      receivedValueMinor: 30_000,
      isPartial: true,
    })
  })

  it('re-matches and recovers shortfall milestone invoices when additional goods arrive', async () => {
    const { service, client, state } = fixture()
    // Initially only 30k received, registering 40k partial invoice
    state.receipts = [
      {
        id: 'rec-1',
        poId: 'po-1',
        status: 'recorded',
        lines: [{ quantity: 3, lineNo: 1 }],
      },
    ]

    const first = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-SHORT',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 40_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )
    expect((first.invoice as InvoiceRecord).status).toBe('exception')

    // Additional receipt arrives with remaining 7 units (70,000 PHP)
    state.receipts.push({
      id: 'rec-2',
      poId: 'po-1',
      status: 'recorded',
      lines: [{ quantity: 7, lineNo: 1 }],
    })

    const rematch = await service.rematchOpenForPo(
      'po-1',
      client as unknown as Prisma.TransactionClient,
    )

    expect(rematch.considered).toBe(1)
    expect(rematch.matched).toBe(1)
    expect(rematch.exceptions).toBe(0)

    const updated = state.invoices.find((i) => i.number === 'INV-STAGE-SHORT')
    expect(updated).toBeDefined()
    expect(updated?.status).toBe('matched')
    const match = updated?.matchResult as {
      isPartial: boolean
      poRemainingMinor: number
    }
    expect(match.isPartial).toBe(true)
    expect(match.poRemainingMinor).toBe(60_000)
  })

  it('demotes a matched milestone invoice upon receipt cancellation via reevaluateMatchedForPo', async () => {
    const { service, client, state } = fixture()

    const first = await service.register(
      {
        vendorId: 'vendor-1',
        number: 'INV-STAGE-1',
        poId: 'po-1',
        allowPartial: true,
        lines: [{ amountMinor: 40_000, class: 'goods' }],
      },
      client as unknown as Prisma.TransactionClient,
    )
    expect((first.invoice as InvoiceRecord).status).toBe('matched')

    // Cancel all receipts
    state.receipts = []

    const reeval = await service.reevaluateMatchedForPo(
      'po-1',
      client as unknown as Prisma.TransactionClient,
    )

    expect(reeval.considered).toBe(1)
    expect(reeval.kept).toBe(0)
    expect(reeval.demoted).toBe(1)

    const updated = state.invoices.find((i) => i.number === 'INV-STAGE-1')
    expect(updated).toBeDefined()
    expect(updated?.status).toBe('received')
    const match = updated?.matchResult as {
      outcome: string
      isPartial: boolean
    }
    expect(match.outcome).toBe('awaiting_receipt')
    expect(match.isPartial).toBe(true)
  })
})
