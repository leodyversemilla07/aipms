import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { db } from '@workspace/db'
import { type ListInput, type ListResult, paginate } from '../trpc/list-input'

export interface CreateBudget {
  name: string
  costCenter: string
  period: string
  currencyCode?: string
  limitMinor: number
}

@Injectable()
export class BudgetService {
  list(input: ListInput): Promise<ListResult<Prisma.BudgetGetPayload<object>>> {
    const { skip, take } = paginate(input)
    const where: Prisma.BudgetWhereInput = input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { costCenter: { contains: input.q, mode: 'insensitive' } },
            { period: { contains: input.q, mode: 'insensitive' } },
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
      db.budget.findMany({ where: where, skip, take, orderBy }),
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
        currencyCode: input.currencyCode ?? 'PHP',
        limitMinor: input.limitMinor,
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
}
