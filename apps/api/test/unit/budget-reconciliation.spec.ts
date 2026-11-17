import './no-database'
import { NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { BudgetService } from '../../src/budget/budget.service'

/**
 * The reconciliation report derives what the budget totals should be from
 * the POs and paid invoices that back them. These fixtures pin the derivation
 * without a database; the integration spec checks it against real records.
 */
describe('budget commitment reconciliation', () => {
  const budget = {
    id: 'budget-1',
    name: 'Materials',
    costCenter: 'IT-PROD',
    period: '2026-01',
    currencyCode: 'PHP',
    limitMinor: 1_000_000,
    committedMinor: 160_000,
    spentMinor: 100_000,
    status: 'open',
    updatedAt: new Date(0),
  }

  function fixture(
    overrides: {
      budget?: object | null
      requisitions?: Array<{ id: string }>
      orders?: Array<{
        id: string
        poNumber: string
        status: string
        currencyCode: string
        totalMinor: number
      }>
      paid?: Array<{
        poId: string | null
        amountMinor: number
        currencyCode: string
      }>
    } = {},
  ) {
    const client = {
      budget: {
        findUnique: vi.fn(async () =>
          overrides.budget === undefined ? budget : overrides.budget,
        ),
      },
      requisition: {
        findMany: vi.fn(async () => overrides.requisitions ?? []),
      },
      purchaseOrder: {
        findMany: vi.fn(async () => overrides.orders ?? []),
      },
      invoice: {
        findMany: vi.fn(async () => overrides.paid ?? []),
      },
    }
    return {
      service: new BudgetService(),
      client: client as unknown as Prisma.TransactionClient,
      calls: client,
    }
  }

  it('refuses a budget that does not exist', async () => {
    const f = fixture({ budget: null })
    await expect(
      f.service.reconciliation('missing', f.client),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('derives committed and spent from the orders and paid invoices', async () => {
    const f = fixture({
      requisitions: [{ id: 'req-1' }],
      orders: [
        {
          id: 'po-1',
          poNumber: 'PO-1',
          status: 'issued',
          currencyCode: 'PHP',
          totalMinor: 160_000,
        },
      ],
      paid: [
        { poId: 'po-1', amountMinor: 60_000, currencyCode: 'PHP' },
        { poId: 'po-1', amountMinor: 40_000, currencyCode: 'PHP' },
      ],
      budget: { ...budget, committedMinor: 60_000, spentMinor: 100_000 },
    })

    const report = await f.service.reconciliation('budget-1', f.client)

    expect(report).toMatchObject({
      expectedCommittedMinor: 60_000,
      expectedSpentMinor: 100_000,
      committedDriftMinor: 0,
      spentDriftMinor: 0,
      ok: true,
    })
    expect(report.rows).toEqual([
      {
        purchaseOrderId: 'po-1',
        poNumber: 'PO-1',
        status: 'issued',
        currencyCode: 'PHP',
        committedMinor: 160_000,
        settledMinor: 100_000,
        remainingMinor: 60_000,
        live: true,
      },
    ])
  })

  it('excludes cancelled orders from the commitment but keeps their settlements', async () => {
    const f = fixture({
      requisitions: [{ id: 'req-1' }],
      orders: [
        {
          id: 'po-1',
          poNumber: 'PO-1',
          status: 'cancelled',
          currencyCode: 'PHP',
          totalMinor: 160_000,
        },
        {
          id: 'po-2',
          poNumber: 'PO-2',
          status: 'confirmed',
          currencyCode: 'PHP',
          totalMinor: 40_000,
        },
      ],
      paid: [{ poId: 'po-2', amountMinor: 10_000, currencyCode: 'PHP' }],
      budget: { ...budget, committedMinor: 30_000, spentMinor: 10_000 },
    })

    const report = await f.service.reconciliation('budget-1', f.client)

    expect(report.expectedCommittedMinor).toBe(30_000)
    expect(report.rows.map((row) => row.live)).toEqual([false, true])
    expect(report.ok).toBe(true)
  })

  it('reports stored drift without changing anything', async () => {
    const f = fixture({
      requisitions: [{ id: 'req-1' }],
      orders: [
        {
          id: 'po-1',
          poNumber: 'PO-1',
          status: 'issued',
          currencyCode: 'PHP',
          totalMinor: 160_000,
        },
      ],
    })

    const report = await f.service.reconciliation('budget-1', f.client)

    expect(report.expectedCommittedMinor).toBe(160_000)
    expect(report.expectedSpentMinor).toBe(0)
    expect(report.committedDriftMinor).toBe(0)
    expect(report.spentDriftMinor).toBe(100_000)
    expect(report.ok).toBe(false)
    expect(f.calls.budget.findUnique).toHaveBeenCalledTimes(1)
  })

  it('flags a currency mismatch instead of throwing on malformed legacy codes', async () => {
    const f = fixture({
      requisitions: [{ id: 'req-1' }],
      orders: [
        {
          id: 'po-1',
          poNumber: 'PO-1',
          status: 'issued',
          currencyCode: 'usd',
          totalMinor: 160_000,
        },
      ],
      paid: [{ poId: 'po-1', amountMinor: 100_000, currencyCode: 'bad' }],
    })

    const report = await f.service.reconciliation('budget-1', f.client)

    expect(report.issues).toEqual([
      'PO-1 uses usd',
      'PO-1 has an invoice in bad',
    ])
    expect(report.ok).toBe(false)
  })

  it('returns an empty, inconsistent report when nothing is linked', async () => {
    const f = fixture()
    const report = await f.service.reconciliation('budget-1', f.client)
    expect(report.rows).toEqual([])
    expect(report.expectedCommittedMinor).toBe(0)
    expect(report.committedDriftMinor).toBe(160_000)
    expect(report.ok).toBe(false)
  })
})
