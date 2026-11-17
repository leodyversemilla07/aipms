import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { BudgetService } from '../src/budget/budget.service'

/**
 * @workspace budget service — remaining computation and derived commitment
 * reconciliation against a real database.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const budgetIds: string[] = []
const requisitionIds: string[] = []
const poIds: string[] = []
const invoiceIds: string[] = []
const vendorIds: string[] = []

afterAll(async () => {
  await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: poIds } } })
  await db.requisition.deleteMany({ where: { id: { in: requisitionIds } } })
  await db.budget.deleteMany({ where: { id: { in: budgetIds } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
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

  it('reconciles derived commitments against the stored budget totals', async () => {
    const b = await budget.create({
      name: `Reconciled ${suffix}`,
      costCenter: `REC-${suffix}`,
      period: '2026-02',
      limitMinor: 1_000_000_00,
    })
    budgetIds.push(b.id)
    const vendor = await db.vendor.create({
      data: { name: `Budget Vendor ${suffix}`, status: 'active' },
    })
    vendorIds.push(vendor.id)
    const requisition = await db.requisition.create({
      data: {
        requestNumber: `REQ-BUD-${suffix}`,
        requestedBy: 'reconciler',
        status: 'approved',
        costCenter: b.costCenter,
        budgetId: b.id,
      },
    })
    requisitionIds.push(requisition.id)
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `PO-BUD-${suffix}`,
        requisitionId: requisition.id,
        vendorId: vendor.id,
        status: 'issued',
        totalMinor: 200_000_00,
        issuedBy: 'reconciler',
      },
    })
    poIds.push(po.id)
    const paid = await db.invoice.create({
      data: {
        poId: po.id,
        vendorId: vendor.id,
        number: `INV-BUD-${suffix}`,
        amountMinor: 120_000_00,
        status: 'paid',
      },
    })
    invoiceIds.push(paid.id)
    await db.budget.update({
      where: { id: b.id },
      data: { committedMinor: 80_000_00, spentMinor: 120_000_00 },
    })

    const report = await budget.reconciliation(b.id)

    expect(report).toMatchObject({
      expectedCommittedMinor: 80_000_00,
      expectedSpentMinor: 120_000_00,
      committedDriftMinor: 0,
      spentDriftMinor: 0,
      ok: true,
    })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({
      purchaseOrderId: po.id,
      poNumber: po.poNumber,
      committedMinor: 200_000_00,
      settledMinor: 120_000_00,
      remainingMinor: 80_000_00,
      live: true,
    })
  })

  it('reports drift when the stored totals disagree with the records', async () => {
    const b = await budget.create({
      name: `Drifted ${suffix}`,
      costCenter: `DRIFT-${suffix}`,
      period: '2026-03',
      limitMinor: 1_000_000_00,
    })
    budgetIds.push(b.id)
    const vendor = await db.vendor.create({
      data: { name: `Drift Vendor ${suffix}`, status: 'active' },
    })
    vendorIds.push(vendor.id)
    const requisition = await db.requisition.create({
      data: {
        requestNumber: `REQ-DRIFT-${suffix}`,
        requestedBy: 'reconciler',
        status: 'approved',
        costCenter: b.costCenter,
        budgetId: b.id,
      },
    })
    requisitionIds.push(requisition.id)
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `PO-DRIFT-${suffix}`,
        requisitionId: requisition.id,
        vendorId: vendor.id,
        status: 'confirmed',
        totalMinor: 100_000_00,
        issuedBy: 'reconciler',
      },
    })
    poIds.push(po.id)
    // A stored total that over-releases the commitment: the floor-at-zero
    // path used to hide exactly this shape of inconsistency.
    await db.budget.update({
      where: { id: b.id },
      data: { committedMinor: 20_000_00 },
    })

    const report = await budget.reconciliation(b.id)

    expect(report.expectedCommittedMinor).toBe(100_000_00)
    expect(report.committedDriftMinor).toBe(-80_000_00)
    expect(report.spentDriftMinor).toBe(0)
    expect(report.ok).toBe(false)
  })
})
