import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { PolicyService } from '../src/policy/policy.service'
import { PurchaseOrderService } from '../src/purchase-order/purchase-order.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { EventRelayService } from '../src/shared/events/event-relay.service'

describe('Requisition → PO automation', () => {
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

  it('issues a PO when requisition is approved', async () => {
    // Get existing budget and vendor from seed
    const budget = await db.budget.findFirst()
    const vendor = await db.vendor.findFirst({ where: { status: 'active' } })
    expect(budget).toBeTruthy()
    expect(vendor).toBeTruthy()

    const policyService = new PolicyService()
    const events = new EventEmitterService()
    const numbers = new DocumentNumberService()
    requisitionService = new RequisitionService(numbers, policyService, events)
    poService = new PurchaseOrderService(numbers, events)

    // Create requisition
    const req = await requisitionService.create({
      requestedBy: 'user-1',
      costCenter: 'IT-PROD',
      budgetId: budget!.id,
      lines: [{ description: 'Test item', quantity: 1, unitPriceMinor: 1000 }],
    })

    // Submit with auto-approve threshold
    const submit = await requisitionService.submit(req.id)
    expect(submit.requisition.status).toBe('approved')

    // Simulate event relay
    relay = new EventRelayService()
    // @ts-expect-error
    const agentService = {
      processPending: async () => ({ documents: 0, succeeded: 0, failed: [] }),
    }
    wake = new AgentWakeService(relay, agentService as any, poService)
    wake.onModuleInit()

    // Poll outbox - should spawn run and issue PO
    // @ts-expect-error
    await (relay as any).poll()

    const runs = await db.agentRun.findMany({
      where: { agentId: 'operator', skills: { has: 'requisition-to-po' } },
    })
    expect(runs.length).toBeGreaterThan(0)
    expect(runs[0].status).toBe('succeeded')

    const po = await db.purchaseOrder.findFirst({
      where: { requisitionId: req.id },
    })
    expect(po).toBeTruthy()
    expect(po?.vendorId).toBe(vendor!.id)
    expect(po?.status).toBe('issued')
  })
})
