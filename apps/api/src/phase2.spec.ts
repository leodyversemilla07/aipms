import { ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { ApprovalService } from './approval/approval.service'
import { BudgetService } from './budget/budget.service'
import { PolicyService } from './policy/policy.service'
import { PurchaseOrderService } from './purchase-order/purchase-order.service'
import { RequisitionService } from './requisition/requisition.service'
import { DocumentNumberService } from './shared/document-number/document-number.service'

/**
 * Phase 2 integration: requisition → §11 gates → PO issue → budget commit →
 * cancellation (with budget release). Runs against local Postgres.
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
  idempotency: [],
  audit: [],
}

const requisitionService = new RequisitionService(
  new DocumentNumberService(),
  new PolicyService(),
)
const purchaseOrderService = new PurchaseOrderService(
  new DocumentNumberService(),
)
const approvalService = new ApprovalService()
const budgetService = new BudgetService()
const policyService = new PolicyService()

afterAll(async () => {
  await db.approval.deleteMany({ where: { id: { in: created.approval } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.budget.deleteMany({ where: { id: { in: created.budget } } })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.idempotencyKey.deleteMany({
    where: { id: { in: created.idempotency } },
  })
  await db.auditEntry.deleteMany({ where: { id: { in: created.audit } } })
  await db.$disconnect()
})

async function makeBudget(limitMinor: number) {
  const budget = await budgetService.create({
    name: `Phase2 ${suffix}`,
    costCenter: `CC-${suffix}-${Math.random().toString(36).slice(2, 6)}`,
    period: '2026-01',
    limitMinor,
  })
  created.budget.push(budget.id)
  return budget
}

async function makeVendor(
  status: 'active' | 'prospective' | 'blacklisted' = 'active',
) {
  const vendor = await db.vendor.create({
    data: {
      name: `Vendor ${suffix}`,
      status,
      taxId: `TAX-${suffix}`,
    },
  })
  created.vendor.push(vendor.id)
  return vendor
}

async function makeThresholdPolicy(
  autoApproveUpTo: number,
  budgetRequired = true,
) {
  const policy = await policyService.create({
    name: `Threshold ${suffix}`,
    kind: 'threshold',
    config: {
      autoApproveUpTo,
      budgetRequired,
      approvalChain: ['manager', 'finance'],
    },
    updatedBy: actorId,
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

describe('Requisition → PO happy path (auto-approve + budget commit)', () => {
  it('auto-approves under threshold, issues a PO, commits budget, cancels and releases', async () => {
    await makeThresholdPolicy(500_000)
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('active')

    const req = await makeRequisition(budget.id, 125_000)
    expect(req.status).toBe('draft')

    const submitted = await requisitionService.submit(req.id)
    expect(submitted.decision.outcome).toBe('PASS')
    expect(submitted.requisition.status).toBe('approved')

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

describe('Threshold gate (human approval)', () => {
  it('routes above-threshold spend to a pending approval; approve unlocks', async () => {
    await makeThresholdPolicy(100_000)
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('active')

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

    const issued = await purchaseOrderService.issue(
      { requisitionId: req.id, vendorId: vendor.id },
      actorId,
    )
    expect(issued.outcome).toBe('ISSUED')
    if (issued.outcome === 'ISSUED') created.po.push(issued.purchaseOrder.id)
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

describe('Vendor gate at PO issue', () => {
  it('requires a human gate for unqualified vendors, then qualifies them', async () => {
    await makeThresholdPolicy(100_000_000)
    const budget = await makeBudget(100_000_000)
    const vendor = await makeVendor('prospective')

    const req = await makeRequisition(budget.id, 50_000)
    await requisitionService.submit(req.id)
    expect((await requisitionService.detail(req.id)).status).toBe('approved')

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
    const req = await makeRequisition(budget.id, 10_000)
    await requisitionService.submit(req.id)

    await expect(
      purchaseOrderService.issue(
        { requisitionId: req.id, vendorId: vendor.id },
        actorId,
      ),
    ).rejects.toThrow(ConflictException)
  })
})
