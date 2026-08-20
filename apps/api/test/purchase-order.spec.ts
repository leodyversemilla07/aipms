import { ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/approval/approval.service'
import { BudgetService } from '../src/budget/budget.service'
import { PolicyService } from '../src/policy/policy.service'
import { PurchaseOrderService } from '../src/purchase-order/purchase-order.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * @workspace purchase-order service — issue (budget commit + vendor gate),
 * confirm, cancellation with budget release. Against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actorId = `test-user-${suffix}`

const created: Record<string, string[]> = {
  requisition: [],
  po: [],
  approval: [],
  budget: [],
  vendor: [],
  policy: [],
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
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.budget.deleteMany({ where: { id: { in: created.budget } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.$disconnect()
})

async function makeBudget(limitMinor: number) {
  const budget = await budgetService.create({
    name: `PO ${suffix}`,
    costCenter: `CC-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    period: '2026-01',
    limitMinor,
  })
  created.budget.push(budget.id)
  return budget
}

async function makeVendor(status: 'active' | 'prospective' | 'blacklisted') {
  const vendor = await db.vendor.create({
    data: { name: `Vendor ${suffix}`, status, taxId: `TAX-${suffix}` },
  })
  created.vendor.push(vendor.id)
  return vendor
}

async function makeThresholdPolicy(autoApproveUpTo: number) {
  const prior = await policyService.latest('threshold', false)
  const policy = await policyService.create({
    name: `Threshold ${suffix}`,
    kind: 'threshold',
    config: {
      autoApproveUpTo,
      budgetRequired: true,
      approvalChain: ['manager', 'finance'],
    },
    updatedBy: actorId,
    supersedesId: prior?.id ?? null,
  })
  created.policy.push(policy.id)
  return policy
}

async function makeApprovedRequisition(budgetId: string, totalMinor: number) {
  const req = await requisitionService.create({
    requestedBy: actorId,
    costCenter: `CC-${suffix}`,
    budgetId,
    lines: [
      { description: 'Test line', quantity: 1, unitPriceMinor: totalMinor },
    ],
  })
  created.requisition.push(req.id)
  const submitted = await requisitionService.submit(req.id)
  expect(submitted.decision.outcome).toBe('PASS')
  return req
}

describe('PO issue + cancellation (budget commit / release)', () => {
  it('auto-approves under threshold, issues a PO, commits budget, cancels and releases', async () => {
    await makeThresholdPolicy(500_000)
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('active')

    const req = await makeApprovedRequisition(budget.id, 125_000)

    const issued = await purchaseOrderService.issue(
      { requisitionId: req.id, vendorId: vendor.id },
      actorId,
    )
    expect(issued.outcome).toBe('ISSUED')
    if (issued.outcome === 'ISSUED') {
      created.po.push(issued.purchaseOrder.id)
      expect(issued.purchaseOrder.totalMinor).toBe(125_000)
      expect(issued.purchaseOrder.status).toBe('issued')
    }

    const after = await budgetService.detail(budget.id)
    expect(after.committedMinor).toBe(125_000)

    const confirmed = await purchaseOrderService.confirm(
      issued.outcome === 'ISSUED' ? issued.purchaseOrder.id : '',
    )
    expect(confirmed.status).toBe('confirmed')

    // Cancellation needs a human gate; approval releases the commit.
    const cancelGate = await purchaseOrderService.requestCancellation(
      confirmed.id,
      'test cancellation',
    )
    created.approval.push(cancelGate.id)
    expect(cancelGate.kind).toBe('poCancellation')

    const decided = await approvalService.decide(
      cancelGate.id,
      'approve',
      actorId,
      'ok',
    )
    expect(decided.outcome).toBe('PO_CANCELLED')

    const released = await budgetService.detail(budget.id)
    expect(released.committedMinor).toBe(0)
    expect((await purchaseOrderService.detail(confirmed.id)).status).toBe(
      'cancelled',
    )
  })
})

describe('Vendor gate at PO issue', () => {
  it('requires a human gate for unqualified vendors, then qualifies them', async () => {
    await makeThresholdPolicy(100_000_000)
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('prospective')

    const req = await makeApprovedRequisition(budget.id, 50_000)

    const first = await purchaseOrderService.issue(
      { requisitionId: req.id, vendorId: vendor.id },
      actorId,
    )
    expect(first.outcome).toBe('NEED_APPROVAL')

    const gate = (await approvalService.pendingList()).find(
      (a) => a.requisitionId === req.id && a.kind === 'vendorGate',
    )
    expect(gate?.vendorId).toBe(vendor.id)
    if (!gate) throw new Error('expected a pending vendor-gate approval')
    created.approval.push(gate.id)

    await approvalService.decide(gate.id, 'approve', actorId, 'vendor ok')
    expect(
      (await db.vendor.findUnique({ where: { id: vendor.id } }))?.status,
    ).toBe('active')

    const issued = await purchaseOrderService.issue(
      { requisitionId: req.id, vendorId: vendor.id },
      actorId,
    )
    expect(issued.outcome).toBe('ISSUED')
    if (issued.outcome === 'ISSUED') created.po.push(issued.purchaseOrder.id)
  })

  it('hard-blocks blacklisted vendors', async () => {
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('blacklisted')
    const req = await makeApprovedRequisition(budget.id, 10_000)

    await expect(
      purchaseOrderService.issue(
        { requisitionId: req.id, vendorId: vendor.id },
        actorId,
      ),
    ).rejects.toThrow(ConflictException)
  })
})
