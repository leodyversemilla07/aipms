import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { containsInsensitive, db } from '@workspace/db'
import {
  assertDatabaseInt,
  normalizeCurrencyCode,
} from '../shared/money/minor-units'
import { type ListInput, type ListResult, paginate } from '../trpc/list-input'

export interface CreateBudget {
  name: string
  costCenter: string
  period: string
  currencyCode?: string
  limitMinor: number
}

/** One PO's contribution to a budget, derived from the domain records. */
export interface CommitmentRow {
  purchaseOrderId: string
  poNumber: string
  status: string
  currencyCode: string
  committedMinor: number
  settledMinor: number
  remainingMinor: number
  /** Only issued/confirmed orders carry a commitment. */
  live: boolean
}

/**
 * What the budget totals should be, from the POs and paid invoices that back
 * them, against what the budget row actually stores.
 *
 * The stored totals are maintained incrementally by PO issue, payment
 * settlement and PO cancellation. This report derives the same numbers from
 * the source facts, so drift from an interrupted or inconsistent write is
 * visible instead of silently constraining future commitments.
 */
export interface BudgetReconciliation {
  budgetId: string
  currencyCode: string
  limitMinor: number
  committedMinor: number
  spentMinor: number
  expectedCommittedMinor: number
  expectedSpentMinor: number
  committedDriftMinor: number
  spentDriftMinor: number
  ok: boolean
  rows: CommitmentRow[]
  issues: string[]
}

@Injectable()
export class BudgetService {
  list(input: ListInput): Promise<ListResult<Prisma.BudgetGetPayload<object>>> {
    const { skip, take } = paginate(input)
    const where: Prisma.BudgetWhereInput = input.q
      ? {
          OR: [
            { name: containsInsensitive(input.q) },
            { costCenter: containsInsensitive(input.q) },
            { period: containsInsensitive(input.q) },
          ],
        }
      : {}

    const orderBy: Prisma.BudgetOrderByWithRelationInput = (
      {
        name: { name: input.dir },
        costCenter: { costCenter: input.dir },
        period: { period: input.dir },
        limitMinor: { limitMinor: input.dir },
        updatedAt: { updatedAt: input.dir },
      } as Record<string, Prisma.BudgetOrderByWithRelationInput>
    )[input.sort] ?? { updatedAt: input.dir }

    return Promise.all([
      db.budget.findMany({ where, skip, take, orderBy }),
      db.budget.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const budget = await db.budget.findUnique({ where: { id } })
    if (!budget) throw new NotFoundException(`Budget ${id} not found`)
    return budget
  }

  create(input: CreateBudget, tx: Prisma.TransactionClient = db) {
    return tx.budget.create({
      data: {
        name: input.name,
        costCenter: input.costCenter,
        period: input.period,
        currencyCode: normalizeCurrencyCode(
          input.currencyCode ?? 'PHP',
          'Budget currency',
        ),
        limitMinor: assertDatabaseInt(input.limitMinor, 'Budget limit'),
      },
    })
  }

  async remaining(id: string) {
    const budget = await this.detail(id)
    return {
      budget,
      remainingMinor:
        budget.limitMinor - budget.committedMinor - budget.spentMinor,
    }
  }

  /**
   * Derives the commitment totals from the POs linked to this budget through
   * their requisitions, and the paid invoices linked to those POs. Read-only:
   * it never repairs the stored totals, so an operator sees the drift before
   * deciding how to account for it.
   */
  async reconciliation(
    id: string,
    client: Prisma.TransactionClient = db,
  ): Promise<BudgetReconciliation> {
    const budget = await client.budget.findUnique({ where: { id } })
    if (!budget) throw new NotFoundException(`Budget ${id} not found`)

    const requisitions = await client.requisition.findMany({
      where: { budgetId: id },
      select: { id: true },
    })
    const requisitionIds = requisitions.map((row) => row.id)
    const orders =
      requisitionIds.length === 0
        ? []
        : await client.purchaseOrder.findMany({
            where: { requisitionId: { in: requisitionIds } },
            select: {
              id: true,
              poNumber: true,
              status: true,
              currencyCode: true,
              totalMinor: true,
            },
            orderBy: { poNumber: 'asc' },
          })
    const orderIds = orders.map((row) => row.id)
    const paid =
      orderIds.length === 0
        ? []
        : await client.invoice.findMany({
            where: { poId: { in: orderIds }, status: 'paid' },
            select: { poId: true, amountMinor: true, currencyCode: true },
          })

    const settledByPo = new Map<string, number>()
    const paidByPo = new Map<string, typeof paid>()
    for (const invoice of paid) {
      if (!invoice.poId) continue
      settledByPo.set(
        invoice.poId,
        (settledByPo.get(invoice.poId) ?? 0) + invoice.amountMinor,
      )
      const list = paidByPo.get(invoice.poId) ?? []
      list.push(invoice)
      paidByPo.set(invoice.poId, list)
    }

    // A read-only report must survive malformed legacy codes, so compare
    // them without the writer's validation, which throws.
    const sameCurrency = (value: string) =>
      value.trim().toUpperCase() === budget.currencyCode.trim().toUpperCase()
    const issues: string[] = []
    const rows: CommitmentRow[] = orders.map((order) => {
      const settledMinor = settledByPo.get(order.id) ?? 0
      const live = order.status === 'issued' || order.status === 'confirmed'
      if (!sameCurrency(order.currencyCode)) {
        issues.push(`${order.poNumber} uses ${order.currencyCode}`)
      }
      for (const invoice of paidByPo.get(order.id) ?? []) {
        if (!sameCurrency(invoice.currencyCode)) {
          issues.push(
            `${order.poNumber} has an invoice in ${invoice.currencyCode}`,
          )
        }
      }
      return {
        purchaseOrderId: order.id,
        poNumber: order.poNumber,
        status: order.status,
        currencyCode: order.currencyCode,
        committedMinor: order.totalMinor,
        settledMinor,
        remainingMinor: order.totalMinor - settledMinor,
        live,
      }
    })

    const expectedCommittedMinor = rows.reduce(
      (sum, row) => sum + (row.live ? row.remainingMinor : 0),
      0,
    )
    const expectedSpentMinor = rows.reduce(
      (sum, row) => sum + row.settledMinor,
      0,
    )
    const committedDriftMinor = budget.committedMinor - expectedCommittedMinor
    const spentDriftMinor = budget.spentMinor - expectedSpentMinor

    return {
      budgetId: budget.id,
      currencyCode: budget.currencyCode,
      limitMinor: budget.limitMinor,
      committedMinor: budget.committedMinor,
      spentMinor: budget.spentMinor,
      expectedCommittedMinor,
      expectedSpentMinor,
      committedDriftMinor,
      spentDriftMinor,
      ok:
        committedDriftMinor === 0 &&
        spentDriftMinor === 0 &&
        issues.length === 0,
      rows,
      issues,
    }
  }
}
