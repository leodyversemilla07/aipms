import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { BudgetService } from '../src/budget/budget.service'

/**
 * @workspace budget service — remaining computation against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const budgetIds: string[] = []

afterAll(async () => {
  await db.budget.deleteMany({ where: { id: { in: budgetIds } } })
  await db.$disconnect()
})

describe('BudgetService', () => {
  const budget = new BudgetService()

  it('creates a budget and computes remaining', async () => {
    const b = await budget.create({
      name: `Q1 Materials ${suffix}`,
      costCenter: `CC-${suffix}`,
      period: '2026-01',
      limitMinor: 1_000_000_00, // ₱1,000,000.00
    })
    budgetIds.push(b.id)

    const remaining = await budget.remaining(b.id)
    expect(remaining.remainingMinor).toBe(1_000_000_00)
    expect(remaining.budget.committedMinor).toBe(0)
  })
})
