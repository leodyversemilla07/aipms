import './no-database'
import { ConflictException } from '@nestjs/common'
import type {
  InvoiceStatus,
  PaymentRunStatus,
  PaymentStatus,
  Prisma,
} from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalService } from '../../src/approval/approval.service'
import { InvoiceService } from '../../src/invoice/invoice.service'
import { PolicyService } from '../../src/policy/policy.service'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'

interface Invoice {
  id: string
  poId: string
  vendorId: string
  number: string
  amountMinor: number
  currencyCode: string
  status: InvoiceStatus
  matchResult?: unknown
}
interface Claim {
  id: string
  invoiceId: string
  status: PaymentStatus
  run: { runNumber: string; status: PaymentRunStatus }
}

function fixture() {
  const state = {
    po: {
      id: 'po-1',
      requisitionId: 'req-1' as string | null,
      status: 'confirmed',
      totalMinor: 100_000,
      currencyCode: 'PHP',
      vendorId: 'vendor-1',
    },
    approval: {
      id: 'gate-1',
      poId: 'po-1' as string | null,
      requisitionId: 'req-1' as string | null,
      kind: 'poCancellation',
      status: 'pending',
      requestedBy: 'maker',
      route: ['finance'],
    },
    budget: {
      id: 'budget-1',
      currencyCode: 'PHP',
      committedMinor: 160_000,
      spentMinor: 25_000,
    },
    invoices: [
      {
        id: 'invoice-1',
        poId: 'po-1',
        vendorId: 'vendor-1',
        number: 'INV-1',
        amountMinor: 100_000,
        currencyCode: 'PHP',
        status: 'matched',
      },
    ] as Invoice[],
    claims: [] as Claim[],
    receipt: null as { receiptNumber: string } | null,
  }
  const timeline: string[] = []
  const events = {
    emit: vi.fn(async ({ type }: { type: string }) => {
      timeline.push(type)
    }),
  }
  const client = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      timeline.push(sql.join('?').replace(/\s+/g, ' ').trim())
      return []
    }),
    user: { findUnique: vi.fn().mockResolvedValue({ role: 'finance' }) },
    approval: {
      findUnique: vi.fn(async () => state.approval),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.approval, data)
        return { count: 1 }
      }),
      findUniqueOrThrow: vi.fn(async () => state.approval),
    },
    purchaseOrder: {
      findUnique: vi.fn(async () => state.po),
      update: vi.fn(async ({ data }) => {
        Object.assign(state.po, data)
        return state.po
      }),
    },
    invoice: {
      findMany: vi.fn(async () => state.invoices),
      update: vi.fn(async ({ where, data }) => {
        const invoice = state.invoices.find((row) => row.id === where.id)
        if (!invoice) throw new Error('Missing fixture invoice')
        Object.assign(invoice, data)
        return invoice
      }),
    },
    paymentRunLine: {
      findFirst: vi.fn(
        async ({ where }) =>
          state.claims.find(
            (claim) =>
              where.invoiceId.in.includes(claim.invoiceId) &&
              (claim.status === 'paid' ||
                (claim.status === 'planned' && claim.run.status !== 'voided')),
          ) ?? null,
      ),
    },
    receipt: { findFirst: vi.fn(async () => state.receipt) },
    requisition: {
      findUnique: vi.fn().mockResolvedValue({ budgetId: 'budget-1' }),
    },
    budget: {
      findUnique: vi.fn(
        async (): Promise<typeof state.budget | null> => state.budget,
      ),
      update: vi.fn(async ({ data }) => {
        state.budget.committedMinor -= data.committedMinor.decrement
        return state.budget
      }),
    },
  }
  const tx = client as unknown as Prisma.TransactionClient
  const invoice = new InvoiceService(
    new PolicyService(),
    events as unknown as EventEmitterService,
  )
  const approval = new ApprovalService(
    events as unknown as EventEmitterService,
    invoice,
  )
  const decide = (verdict: 'approve' | 'reject' | 'override' = 'approve') =>
    approval.decide('gate-1', verdict, 'checker', 'fixture evidence', tx)
  return { state, timeline, client, tx, invoice, decide }
}

function claim(status: PaymentStatus, runStatus: PaymentRunStatus): Claim {
  return {
    id: 'line-1',
    invoiceId: 'invoice-1',
    status,
    run: { runNumber: 'RUN-1', status: runStatus },
  }
}

describe('PO cancellation preserves payment and budget invariants', () => {
  it('demotes stale matches and releases only this unpaid PO commitment', async () => {
    const { state, client, timeline, decide } = fixture()
    expect((await decide()).outcome).toBe('PO_CANCELLED')
    expect(state.po.status).toBe('cancelled')
    expect(state.invoices[0].status).toBe('exception')
    expect(state.invoices[0].matchResult).toMatchObject({
      outcome: 'po_not_live',
    })
    expect(state.budget).toMatchObject({
      committedMinor: 60_000,
      spentMinor: 25_000,
    })
    expect(client.budget.update).toHaveBeenCalledWith({
      where: { id: 'budget-1' },
      data: { committedMinor: { decrement: 100_000 } },
    })
    const poLock = timeline.findIndex((entry) =>
      entry.includes('FROM "purchaseOrder"'),
    )
    const invoiceLock = timeline.findIndex((entry) =>
      entry.includes('FROM "invoice"'),
    )
    const budgetLock = timeline.findIndex((entry) =>
      entry.includes('FROM budget'),
    )
    expect(poLock).toBeGreaterThanOrEqual(0)
    expect(invoiceLock).toBeGreaterThan(poLock)
    expect(budgetLock).toBeGreaterThan(invoiceLock)
    expect(timeline.at(-1)).toBe('po.cancelled')
  })

  it.each(['approve', 'override'] as const)(
    'refuses %s of a paid PO without consuming another PO commitment',
    async (verdict) => {
      const { state, client, decide } = fixture()
      state.invoices[0].status = 'paid'
      state.budget.committedMinor = 60_000
      state.budget.spentMinor = 100_000
      const before = structuredClone(state.budget)
      await expect(decide(verdict)).rejects.toThrow(/paid.*return\/refund/)
      expect(client.purchaseOrder.update).not.toHaveBeenCalled()
      expect(client.budget.update).not.toHaveBeenCalled()
      expect(state.budget).toEqual(before)
    },
  )

  it.each(['draft', 'approved', 'executed', 'reconciled'] as const)(
    'blocks a planned reservation on a %s run',
    async (status) => {
      const { state, client, decide } = fixture()
      state.claims.push(claim('planned', status))
      await expect(decide()).rejects.toThrow(/claimed by payment run RUN-1/)
      expect(client.purchaseOrder.update).not.toHaveBeenCalled()
      expect(client.budget.update).not.toHaveBeenCalled()
    },
  )

  it('checks reservations even when the invoice is no longer matched', async () => {
    const { state, client, decide } = fixture()
    state.invoices[0].status = 'received'
    state.claims.push(claim('planned', 'approved'))
    await expect(decide()).rejects.toBeInstanceOf(ConflictException)
    expect(client.paymentRunLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          invoiceId: { in: ['invoice-1'] },
          OR: [
            { status: 'paid' },
            { status: 'planned', run: { status: { not: 'voided' } } },
          ],
        },
      }),
    )
  })

  it('blocks paid payment history even if the stored invoice status is stale', async () => {
    const { state, client, decide } = fixture()
    state.claims.push(claim('paid', 'voided'))
    await expect(decide()).rejects.toThrow(/paid line.*return\/refund/)
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it.each([
    ['planned', 'voided'],
    ['dishonored', 'executed'],
    ['rejected', 'reconciled'],
  ] as const)('allows released %s / %s claims', async (status, runStatus) => {
    const { state, decide } = fixture()
    state.claims.push(claim(status, runStatus))
    expect((await decide()).outcome).toBe('PO_CANCELLED')
    expect(state.invoices[0].status).toBe('exception')
    expect(state.budget.committedMinor).toBe(60_000)
  })

  it('requires recorded receipts to be resolved before cancelling', async () => {
    const { state, client, decide } = fixture()
    state.receipt = { receiptNumber: 'GR-1' }
    await expect(decide()).rejects.toThrow(/recorded receipt GR-1/)
    expect(client.purchaseOrder.update).not.toHaveBeenCalled()
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('does not use a mismatched approval to release another requisition budget', async () => {
    const { state, client, decide } = fixture()
    state.approval.requisitionId = 'wrong-requisition'
    await expect(decide()).rejects.toThrow(/does not match/)
    expect(client.requisition.findUnique).not.toHaveBeenCalled()
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('refuses an inconsistent shared commitment instead of flooring it to zero', async () => {
    const { state, client, timeline, decide } = fixture()
    state.budget.committedMinor = 60_000
    await expect(decide()).rejects.toThrow(/commitment is inconsistent/)
    expect(client.budget.update).not.toHaveBeenCalled()
    expect(state.budget.committedMinor).toBe(60_000)
    expect(timeline).not.toContain('po.cancelled')
  })

  it('refuses a cancellation gate without a PO instead of deciding its requisition', async () => {
    const { state, client, decide } = fixture()
    state.approval.poId = null
    await expect(decide()).rejects.toThrow(/has no purchase order/)
    expect(client.requisition.findUnique).not.toHaveBeenCalled()
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('refuses a negative commitment rather than increasing the shared balance', async () => {
    const { state, client, decide } = fixture()
    state.po.totalMinor = -100_000
    await expect(decide()).rejects.toThrow(
      /supported signed 32-bit integer range/,
    )
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('refuses implicit FX during commitment release', async () => {
    const { state, client, decide } = fixture()
    state.budget.currencyCode = 'USD'
    await expect(decide()).rejects.toThrow(/currencies differ/)
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it.each(['requisition', 'budget'] as const)(
    'fails closed on a missing %s link',
    async (model) => {
      const { client, decide } = fixture()
      client[model].findUnique.mockResolvedValue(null)
      await expect(decide()).rejects.toThrow(/not found/)
      expect(client.budget.update).not.toHaveBeenCalled()
    },
  )

  it('fails closed when a budgeted requisition loses its budget assignment', async () => {
    const { client, decide } = fixture()
    client.requisition.findUnique.mockResolvedValue({ budgetId: null })
    await expect(decide()).rejects.toThrow(/has no budget/)
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('does not release budget again for an already cancelled PO', async () => {
    const { state, client, decide } = fixture()
    state.po.status = 'cancelled'
    expect((await decide()).outcome).toBe('KEPT')
    expect(client.invoice.findMany).not.toHaveBeenCalled()
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('permits rejecting a cancellation request even when the PO is paid', async () => {
    const { state, client, decide } = fixture()
    state.invoices[0].status = 'paid'
    expect((await decide('reject')).outcome).toBe('KEPT')
    expect(client.invoice.findMany).not.toHaveBeenCalled()
    expect(client.purchaseOrder.update).not.toHaveBeenCalled()
    expect(client.budget.update).not.toHaveBeenCalled()
  })

  it('can cancel an unpaid standalone PO without inventing a budget release', async () => {
    const { state, client, decide } = fixture()
    state.po.requisitionId = null
    state.approval.requisitionId = null
    expect((await decide()).outcome).toBe('PO_CANCELLED')
    expect(client.budget.update).not.toHaveBeenCalled()
    expect(state.invoices[0].status).toBe('exception')
  })
})

describe('shared invoice correction guard', () => {
  it('awaits the invoice lock before reading eligibility and reservations', async () => {
    const { state, client, tx, invoice } = fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const locked = new Promise<void>((resolve) => {
      entered = resolve
    })
    client.$queryRaw.mockImplementation(async (sql) => {
      expect(sql.join('?')).toMatch(/ORDER BY id FOR UPDATE/)
      entered()
      await gate
      return []
    })
    const result = invoice.assertPoCorrectionAllowed('po-1', tx)
    await locked
    expect(client.invoice.findMany).not.toHaveBeenCalled()
    expect(client.paymentRunLine.findFirst).not.toHaveBeenCalled()
    // Synthetic ordering probe: a planner commits while lock acquisition waits.
    // PostgreSQL concurrency semantics are covered by the guarded DB suite.
    state.claims.push(claim('planned', 'draft'))
    release()
    await expect(result).rejects.toThrow(/claimed by payment run/)
  })

  it('refuses receipt reevaluation after the invoice has been paid', async () => {
    const { state, client, tx, invoice } = fixture()
    state.invoices[0].status = 'paid'
    await expect(invoice.reevaluateMatchedForPo('po-1', tx)).rejects.toThrow(
      /paid.*return\/refund/,
    )
    expect(client.invoice.update).not.toHaveBeenCalled()
  })

  it('supports corrections on a PO with no invoices', async () => {
    const { state, client, tx, invoice } = fixture()
    state.invoices = []
    expect(await invoice.reevaluateMatchedForPo('po-1', tx)).toEqual({
      considered: 0,
      kept: 0,
      demoted: 0,
    })
    expect(client.paymentRunLine.findFirst).not.toHaveBeenCalled()
  })
})
