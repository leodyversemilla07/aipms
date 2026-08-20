import { ForbiddenException } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/approval/approval.service'
import { BudgetService } from '../src/budget/budget.service'
import { PolicyService } from '../src/policy/policy.service'
import { PurchaseOrderService } from '../src/purchase-order/purchase-order.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { requireRole } from '../src/trpc/authorize'

/**
 * @workspace authorization — §10 roles and approval-route enforcement.
 * Any authenticated human used to be able to decide any pending gate; now the
 * deciding actor must hold a role named on the approval's route (admin
 * bypasses, unknown principals such as the agent are rejected outright).
 */

const suffix = Math.random().toString(36).slice(2, 8)
const created: Record<string, string[]> = {
  requisition: [],
  approval: [],
  budget: [],
  policy: [],
  vendor: [],
  po: [],
}

const users = {
  finance: `authz-finance-${suffix}`,
  procurement: `authz-procurement-${suffix}`,
  plain: `authz-plain-${suffix}`,
  admin: `authz-admin-${suffix}`,
}

const requisitionService = new RequisitionService(
  new DocumentNumberService(),
  new PolicyService(),
  new EventEmitterService(),
)
const purchaseOrderService = new PurchaseOrderService(
  new DocumentNumberService(),
  new EventEmitterService(),
)
const approvalService = new ApprovalService(new EventEmitterService())
const budgetService = new BudgetService()
const policyService = new PolicyService()

beforeAll(async () => {
  await db.user.createMany({
    data: [
      { id: users.finance, name: 'A Finance', email: `${users.finance}@test.aipms`, role: 'finance' },
      {
        id: users.procurement,
        name: 'A Procurement',
        email: `${users.procurement}@test.aipms`,
        role: 'procurement',
      },
      { id: users.plain, name: 'A User', email: `${users.plain}@test.aipms`, role: 'user' },
      { id: users.admin, name: 'An Admin', email: `${users.admin}@test.aipms`, role: 'admin' },
    ],
  })
})

afterAll(async () => {
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.approval.deleteMany({ where: { id: { in: created.approval } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.budget.deleteMany({ where: { id: { in: created.budget } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.user.deleteMany({
    where: { id: { in: Object.values(users) } },
  })
  await db.$disconnect()
})

async function makePolicy(
  name: string,
  config: Record<string, unknown>,
) {
  const prior = await policyService.latest('threshold', false)
  const policy = await policyService.create({
    name: `${name} ${suffix}`,
    kind: 'threshold',
    config,
    updatedBy: users.admin,
    supersedesId: prior?.id ?? null,
  })
  created.policy.push(policy.id)
  return policy
}

async function makeBudget(limitMinor: number) {
  const budget = await budgetService.create({
    name: `Authz ${suffix}`,
    costCenter: `CC-AUTHZ-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    period: '2026-01',
    limitMinor,
  })
  created.budget.push(budget.id)
  return budget
}

async function makeRequisition(budgetId: string, totalMinor: number) {
  const req = await requisitionService.create({
    requestedBy: users.plain,
    costCenter: `CC-AUTHZ-${suffix}`,
    budgetId,
    lines: [{ description: 'Authz line', quantity: 1, unitPriceMinor: totalMinor }],
  })
  created.requisition.push(req.id)
  return req
}

describe('Approval route enforcement (§10)', () => {
  it('threshold gates route to finance: plain users are forbidden, finance can decide', async () => {
    await makePolicy('Threshold Finance Only', {
      autoApproveUpTo: 0,
      budgetRequired: true,
      approvalChain: ['finance'],
    })
    const budget = await makeBudget(100_000_000)
    const req = await makeRequisition(budget.id, 250_000)
    const submitted = await requisitionService.submit(req.id)
    expect(submitted.decision.outcome).toBe('NEED_APPROVAL')

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id,
    )
    expect(gate).toBeDefined()
    expect(gate?.route).toContain('finance')
    if (!gate) throw new Error('expected a pending threshold approval')
    created.approval.push(gate.id)

    await expect(
      approvalService.decide(gate.id, 'approve', users.plain, 'nope'),
    ).rejects.toThrow(ForbiddenException)

    const decided = await approvalService.decide(
      gate.id,
      'approve',
      users.finance,
      'ok',
    )
    expect(decided.outcome).toBe('APPROVED')
  })

  it('vendor gates route to procurement: finance cannot decide them', async () => {
    await makePolicy('Threshold Pass-Through', {
      autoApproveUpTo: 100_000_000,
      budgetRequired: true,
    })
    const budget = await makeBudget(100_000_000)
    const vendor = await db.vendor.create({
      data: {
        name: `Authz Vendor ${suffix}`,
        status: 'prospective',
        taxId: `TAX-AUTHZ-${suffix}`,
      },
    })
    created.vendor.push(vendor.id)
    const req = await makeRequisition(budget.id, 50_000)
    const submitted = await requisitionService.submit(req.id)
    expect(submitted.decision.outcome).toBe('PASS')

    const first = await purchaseOrderService.issue(
      { requisitionId: req.id, vendorId: vendor.id },
      users.plain,
    )
    expect(first.outcome).toBe('NEED_APPROVAL')

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id && a.kind === 'vendorGate',
    )
    expect(gate?.route).toContain('procurement')
    if (!gate) throw new Error('expected a pending vendor-gate approval')
    created.approval.push(gate.id)

    await expect(
      approvalService.decide(gate.id, 'approve', users.finance, 'nope'),
    ).rejects.toThrow(ForbiddenException)

    await approvalService.decide(gate.id, 'approve', users.procurement, 'ok')
    expect(
      (await db.vendor.findUnique({ where: { id: vendor.id } }))?.status,
    ).toBe('active')
  })

  it('admin bypasses route membership', async () => {
    await makePolicy('Threshold Admin Check', {
      autoApproveUpTo: 0,
      budgetRequired: true,
      approvalChain: ['cfo'],
    })
    const budget = await makeBudget(100_000_000)
    const req = await makeRequisition(budget.id, 250_000)
    const submitted = await requisitionService.submit(req.id)
    expect(submitted.decision.outcome).toBe('NEED_APPROVAL')

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id,
    )
    if (!gate) throw new Error('expected a pending threshold approval')
    created.approval.push(gate.id)

    // 'cfo' is not a UserRole — only admin may decide such a route.
    await expect(
      approvalService.decide(gate.id, 'approve', users.finance, 'nope'),
    ).rejects.toThrow(ForbiddenException)
    const decided = await approvalService.decide(
      gate.id,
      'approve',
      users.admin,
      'admin override',
    )
    expect(decided.outcome).toBe('APPROVED')
  })

  it('unknown principals (e.g. the agent) cannot decide human gates', async () => {
    await makePolicy('Threshold Unknown Actor', {
      autoApproveUpTo: 0,
      budgetRequired: true,
      approvalChain: ['finance'],
    })
    const budget = await makeBudget(100_000_000)
    const req = await makeRequisition(budget.id, 250_000)
    await requisitionService.submit(req.id)

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id,
    )
    if (!gate) throw new Error('expected a pending threshold approval')
    created.approval.push(gate.id)

    await expect(
      approvalService.decide(gate.id, 'approve', 'agent-operator', 'nope'),
    ).rejects.toThrow(ForbiddenException)
  })
})

describe('requireRole gate (§10)', () => {
  it('rejects humans without the required role', () => {
    expect(() =>
      requireRole({ role: 'user' }, 'human', ['finance'], 'paymentRun.approve'),
    ).toThrow(TRPCError)
  })

  it('accepts admins and route members', () => {
    expect(() =>
      requireRole({ role: 'admin' }, 'human', ['finance'], 'x'),
    ).not.toThrow()
    expect(() =>
      requireRole({ role: 'finance' }, 'human', ['finance'], 'x'),
    ).not.toThrow()
  })

  it('bypasses role checks for agent principals (scopes govern them)', () => {
    expect(() =>
      requireRole(undefined, 'agent', ['finance'], 'x'),
    ).not.toThrow()
  })
})
