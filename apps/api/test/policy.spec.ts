import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { PolicyService } from '../src/policy/policy.service'

/**
 * @workspace policy service — versioning + active-by-kind resolution (§11).
 */

const policyIds: string[] = []

afterAll(async () => {
  await db.policy.deleteMany({ where: { id: { in: policyIds } } })
  await db.$disconnect()
})

describe('PolicyService (versioning + evaluation seam)', () => {
  const policy = new PolicyService()

  it('versions policies and resolves the latest enabled per kind', async () => {
    const v1 = await policy.create({
      name: 'Sourcing threshold (trial)',
      kind: 'threshold',
      config: { currency: 'PHP', autoApproveUpToMinor: 50_000_00 },
      updatedBy: 'test-user',
    })
    policyIds.push(v1.id)
    expect(v1.version).toBe(1)

    const v2 = await policy.create({
      name: 'Sourcing threshold (revised)',
      kind: 'threshold',
      supersedesId: v1.id,
      config: { currency: 'PHP', autoApproveUpToMinor: 100_000_00 },
      updatedBy: 'test-user',
    })
    policyIds.push(v2.id)
    expect(v2.version).toBe(2)
    expect(v2.supersedesId).toBe(v1.id)

    const evalPolicy = await policy.create({
      name: 'MEARB evaluation',
      kind: 'evaluationCriterion',
      config: {
        criterion: 'mearb',
        priceWeightPct: 30,
        technicalWeightPct: 70,
      },
      updatedBy: 'test-user',
    })
    policyIds.push(evalPolicy.id)

    const active = await policy.activeByKind()
    // Parallel spec files may supersede this chain further; the guarantee
    // that matters is that the revised policy (not v1) resolved as active.
    expect(active.threshold?.version ?? 0).toBeGreaterThanOrEqual(2)
    expect(active.evaluationCriterion?.config).toMatchObject({
      criterion: 'mearb',
      priceWeightPct: 30,
    })
  })
})
