import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/approval/approval.service'
import { BudgetService } from '../src/budget/budget.service'
import { PolicyService } from '../src/policy/policy.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * @workspace requisition service — §11 gate outcomes on submit
 * (auto-approve becomes approved; above-threshold / budget-override route to a
 * pending human approval). Against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorId = `test-user-${suffix}`

const created: Record<string, string[]> = {
  requisition: [],
  approval: [],
  budget: [],
  policy: [],
}

const requisitionService = new RequisitionService(
  new DocumentNumberService(),
  new PolicyService(),
  new EventEmitterService(),
)
const approvalService = new ApprovalService(new EventEmitterService())
const budgetService = new BudgetService()
const policyService = new PolicyService()

// §10: decide() requires a real actor — an admin bypasses route membership.
beforeAll(async () => {
  await db.user.create({
    data: {
      id: actorId,
      name: 'Test Admin',
      email: `${actorId}@test.aipms`,
      role: 'admin',
    },
  })
})

afterAll(async () => {
  await db.user.deleteMany({ where: { id: actorId } })
  await db.approval.deleteMany({ where: { id: { in: created.approval } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.budget.deleteMany({ where: { id: { in: created.budget } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.$disconnect()
})

async function makeBudget(limitMinor: number) {
  const budget = await budgetService.create({
    name: `Req ${suffix}`,
    costCenter: `CC-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    period: '2026-01',
    limitMinor,
  })
  created.budget.push(budget.id)
  return budget
}

async function makeThresholdPolicy(
  autoApproveUpTo: number,
  budgetRequired = true,
) {
  // Supersede so this policy is strictly the newest version — latest() must
  // resolve deterministically to it.
  const prior = await policyService.latest('threshold', false)
  const policy = await policyService.create({
    name: `Threshold ${suffix}`,
    kind: 'threshold',
    config: {
      autoApproveUpTo,
      budgetRequired,
      approvalChain: ['manager', 'finance'],
    },
    updatedBy: actorId,
    supersedesId: prior?.id ?? null,
  })
  created.policy.push(policy.id)
  return policy
}

async function makeRequisition(budgetId: string, totalMinor: number) {
  const req = await requisitionService.create({
    requestedBy: actorId,
    costCenter: `CC-${suffix}`,
    budgetId,
    lines: [
      { description: 'Test line', quantity: 1, unitPriceMinor: totalMinor },
    ],
  })
  created.requisition.push(req.id)
  return req
}

describe('Threshold gate (human approval)', () => {
  it('routes above-threshold spend to a pending approval; approve unlocks', async () => {
    await makeThresholdPolicy(100_000)
    const budget = await makeBudget(100_000_000)

    const req = await makeRequisition(budget.id, 250_000)
    const submitted = await requisitionService.submit(req.id)

    expect(submitted.decision.outcome).toBe('NEED_APPROVAL')
    expect(submitted.requisition.status).toBe('submitted')

    const pending = await approvalService.pendingList()
    const gate = pending.find((a) => a.requisitionId === req.id)
    expect(gate).toBeDefined()
    expect(gate?.kind).toBe('threshold')
    if (!gate) throw new Error('expected a pending threshold approval')
    created.approval.push(gate.id)

    const decided = await approvalService.decide(
      gate.id,
      'approve',
      actorId,
      'ok',
    )
    expect(decided.outcome).toBe('APPROVED')
    expect(decided.requisitionStatus).toBe('approved')
  })
})

describe('Budget override gate', () => {
  it('flags spend beyond remaining budget as a budgetOverride approval', async () => {
    await makeThresholdPolicy(100_000_000)
    const budget = await makeBudget(100_000) // ₱1,000 budget
    const req = await makeRequisition(budget.id, 250_000)

    const submitted = await requisitionService.submit(req.id)
    expect(submitted.decision.outcome).toBe('NEED_APPROVAL')
    expect(submitted.decision.gateKind).toBe('budgetOverride')

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id,
    )
    expect(gate?.kind).toBe('budgetOverride')
    if (gate) created.approval.push(gate.id)
  })
})
