import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { PolicyService } from '../src/policy/policy.service'
import { PurchaseOrderService } from '../src/purchase-order/purchase-order.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { EventRelayService } from '../src/shared/events/event-relay.service'

describe('AgentWakeService policy-driven vendor selection', () => {
  let relay: EventRelayService
  let wake: AgentWakeService
  let requisitionService: RequisitionService
  let poService: PurchaseOrderService

  beforeEach(async () => {
    await db.agentRun.deleteMany({})
    await db.domainEvent.deleteMany({})
    await db.purchaseOrder.deleteMany({})
    await db.requisition.deleteMany({})
    await db.approval.deleteMany({})
    await db.policy.deleteMany({ where: { kind: 'preferredVendor' } })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('uses preferredVendor policy when issuing PO', async () => {
    const budget = await db.budget.findFirst()
    let vendors = await db.vendor.findMany({ where: { status: 'active' } })
    expect(budget).toBeTruthy()
    // Ensure at least two vendors exist
    if (vendors.length < 2) {
      const extra = await db.vendor.create({
        data: {
          name: 'Second Vendor',
          status: 'active',
        },
      })
      vendors = [vendors[0], extra]
    }
    const preferredVendor = vendors[1]
    const fallbackVendor = vendors[0]

    // Create preferred vendor policy
    await db.policy.create({
      data: {
        name: 'Preferred Vendor',
        kind: 'preferredVendor',
        enabled: true,
        config: { vendorId: preferredVendor.id },
        updatedBy: 'system',
      },
    })

    const policyService = new PolicyService()
    const events = new EventEmitterService()
    const numbers = new DocumentNumberService()
    requisitionService = new RequisitionService(numbers, policyService, events)
    poService = new PurchaseOrderService(numbers, events)

    const req = await requisitionService.create({
      requestedBy: 'user-1',
      costCenter: 'IT-PROD',
      budgetId: budget.id,
      lines: [{ description: 'Test', quantity: 1, unitPriceMinor: 500 }],
    })
    await requisitionService.submit(req.id)

    relay = new EventRelayService()
    const agentService = {
      processPending: async () => ({ documents: 0, succeeded: 0, failed: [] }),
    }
    wake = new AgentWakeService(
      relay,
      agentService as unknown as AgentService,
      poService,
    )
    wake.onModuleInit()

    await (relay as unknown as { poll(): Promise<void> }).poll()

    const po = await db.purchaseOrder.findFirst({
      where: { requisitionId: req.id },
    })
    expect(po).toBeTruthy()
    expect(po?.vendorId).toBe(preferredVendor.id)
    expect(po?.vendorId).not.toBe(fallbackVendor.id)
  })
})
