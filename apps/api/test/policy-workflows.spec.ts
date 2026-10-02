import { randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandService } from '../src/agent/agent-command.service'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { PolicyService } from '../src/policy/policy.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import type { EventRelayService } from '../src/shared/events/event-relay.service'
import { SourcingService } from '../src/sourcing/sourcing.service'

const prefix = `policy-flow-${randomUUID()}`
const requisitionIds: string[] = []
const policyIds: string[] = []
const vendorIds: string[] = []
const policies = new PolicyService()
const events = new EventEmitterService()
const requisitions = new RequisitionService(
  new DocumentNumberService(),
  policies,
  events,
)

afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  const ownedEvents = await db.domainEvent.findMany({
    where: { entityId: { in: requisitionIds } },
    select: { id: true },
  })
  await db.agentRun.deleteMany({
    where: { triggerEventId: { in: ownedEvents.map((row) => row.id) } },
  })
  await db.domainEvent.deleteMany({
    where: { entityId: { in: requisitionIds } },
  })
  const quotes = await db.quote.findMany({
    where: { requisitionId: { in: requisitionIds } },
    select: { id: true },
  })
  await db.domainEvent.deleteMany({
    where: { entityId: { in: quotes.map((row) => row.id) } },
  })
  await db.quote.deleteMany({
    where: { requisitionId: { in: requisitionIds } },
  })
  await db.requisition.deleteMany({ where: { id: { in: requisitionIds } } })
  await db.policy.deleteMany({ where: { id: { in: policyIds } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await db.$disconnect()
})

async function rule(
  kind: 'threshold' | 'preferredVendor' | 'evaluationCriterion',
  config: object,
) {
  const row = await policies.create({
    name: prefix,
    kind,
    config,
    updatedBy: prefix,
  })
  policyIds.push(row.id)
  return row
}
async function request(costCenter: string) {
  const req = await requisitions.create({
    requestedBy: prefix,
    costCenter,
    lines: [
      {
        description: 'Fictional procurement',
        quantity: 1,
        unitPriceMinor: 500,
      },
    ],
  })
  requisitionIds.push(req.id)
  return req
}
async function vendor(ratingScore = 50) {
  const row = await db.vendor.create({
    data: { name: `${prefix}-${randomUUID()}`, status: 'active', ratingScore },
  })
  vendorIds.push(row.id)
  return row
}

/** Real wake handler and PostgreSQL records; only relay/command delivery is injected. */
async function wakeApproved(
  requisitionId: string,
  expectMissingVendor = false,
) {
  vi.stubEnv('AIPMS_AGENT_WAKE', '1')
  type Handler = (event: {
    id: string
    type: string
    entityType: string
    entityId: string
    payload: Record<string, unknown>
    createdAt: Date
  }) => Promise<void>
  const handlers = new Map<string, Handler>()
  const relay = {
    subscribe: (type: string, handler: Handler) => {
      handlers.set(type, handler)
    },
  }
  const issuePurchaseOrder = vi.fn(async () => ({
    outcome: 'ISSUED',
    purchaseOrder: { id: 'injected-po', poNumber: 'INJECTED-PO' },
  }))
  const wake = new AgentWakeService(
    relay as unknown as EventRelayService,
    { issuePurchaseOrder } as unknown as AgentCommandService,
  )
  wake.onModuleInit()
  const event = await db.domainEvent.findFirstOrThrow({
    where: { type: 'requisition.approved', entityId: requisitionId },
  })
  const callback = handlers.get('requisition.approved')
  if (!callback) throw new Error('Wake subscription missing')
  const delivery = callback({
    ...event,
    payload: event.payload as Record<string, unknown>,
  })
  if (expectMissingVendor)
    await expect(delivery).rejects.toThrow(/preferred vendor is unavailable/)
  else await delivery
  const run = await db.agentRun.findUniqueOrThrow({
    where: { triggerEventId: event.id },
  })
  return { issuePurchaseOrder, run }
}

describe('consistent policy decisions across workflows (PostgreSQL)', () => {
  it('interactive submission and an older approved event both obey a new restrictive threshold', async () => {
    const scope = `${prefix}-threshold`
    const permissive = await rule('threshold', { scope, autoApproveUpTo: 1000 })
    const previouslyApproved = await request(scope)
    expect(
      (await requisitions.submit(previouslyApproved.id)).decision.outcome,
    ).toBe('PASS')
    const restrictive = await rule('threshold', { scope, autoApproveUpTo: 100 })
    // Simulate a pre-upgrade database with both old and new revisions enabled.
    await db.policy.update({
      where: { id: permissive.id },
      data: { enabled: true },
    })
    const current = await request(scope)
    const submitted = await requisitions.submit(current.id)
    expect(submitted.decision.outcome).toBe('NEED_APPROVAL')
    expect(submitted.decision.citations).toContain(
      `policy:${prefix}@v${restrictive.version}`,
    )
    const wake = await wakeApproved(previouslyApproved.id)
    expect(wake.issuePurchaseOrder).not.toHaveBeenCalled()
    expect(wake.run.meta).toMatchObject({
      skipped: 'NEED_APPROVAL',
      decision: { citations: submitted.decision.citations },
    })
  })

  it('wake chooses the newest applicable preferred vendor, not the first legacy row', async () => {
    const scope = `${prefix}-vendor`
    await rule('threshold', { scope, autoApproveUpTo: 1000 })
    const oldVendor = await vendor()
    const newVendor = await vendor()
    const old = await rule('preferredVendor', { scope, vendorId: oldVendor.id })
    const latest = await rule('preferredVendor', {
      scope,
      vendorId: newVendor.id,
    })
    await db.policy.update({ where: { id: old.id }, data: { enabled: true } })
    const req = await request(scope)
    await requisitions.submit(req.id)
    const wake = await wakeApproved(req.id)
    expect(wake.issuePurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: newVendor.id }),
      expect.any(Object),
    )
    expect(wake.run.meta).toMatchObject({
      preferredVendorPolicyId: latest.id,
      preferredVendorPolicyVersion: latest.version,
    })
  })

  it('a configured missing preferred vendor fails rather than silently choosing an arbitrary fallback', async () => {
    const scope = `${prefix}-missing-vendor`
    await rule('threshold', { scope, autoApproveUpTo: 1000 })
    await rule('preferredVendor', { scope, vendorId: randomUUID() })
    const req = await request(scope)
    await requisitions.submit(req.id)
    const wake = await wakeApproved(req.id, true)
    expect(wake.issuePurchaseOrder).not.toHaveBeenCalled()
    expect(wake.run.status).toBe('failed')
    expect(wake.run.meta).toMatchObject({
      error: expect.stringContaining('preferred vendor is unavailable'),
    })
  })

  it('sourcing compares and awards using version precedence, not legacy edit time', async () => {
    const scope = `${prefix}-sourcing`
    await rule('threshold', { scope, autoApproveUpTo: 1000 })
    const old = await rule('evaluationCriterion', {
      scope,
      criterion: 'lowestCost',
    })
    const latest = await rule('evaluationCriterion', {
      scope,
      criterion: 'bestValue',
      priceWeight: 0,
    })
    await db.policy.update({
      where: { id: old.id },
      data: { enabled: true, updatedAt: new Date(Date.now() + 60_000) },
    })
    const req = await request(scope)
    await requisitions.submit(req.id)
    const cheap = await vendor(0)
    const highRated = await vendor(100)
    const sourcing = new SourcingService(events)
    const quotes = await sourcing.request(
      req.id,
      [cheap.id, highRated.id],
      prefix,
    )
    for (const quote of quotes)
      await sourcing.receive(quote.id, {
        totalMinor: quote.vendorId === cheap.id ? 100 : 200,
      })
    const comparison = await sourcing.compare(req.id)
    const winner = quotes.find((quote) => quote.vendorId === highRated.id)
    expect(winner).toBeTruthy()
    expect(comparison).toMatchObject({
      criterion: 'bestValue',
      priceWeight: 0,
      recommendedQuoteId: winner?.id,
      policyId: latest.id,
      policyVersion: latest.version,
    })
    await sourcing.award(winner?.id ?? '', prefix)
    const event = await db.domainEvent.findFirstOrThrow({
      where: { type: 'quote.awarded', entityId: winner?.id },
    })
    expect(event.payload).toMatchObject({
      criterion: 'bestValue',
      policyId: latest.id,
      policyVersion: latest.version,
    })
  })
})
