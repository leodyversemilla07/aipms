import { ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PolicyService } from '../src/policy/policy.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { SourcingService } from '../src/sourcing/sourcing.service'

/**
 * §8.1 structured quoting — RFQ open → offer receive → deterministic compare
 * (lowestCost default / bestValue via evaluationCriterion policy) → exclusive
 * award with outbox event. Against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const actor = `buyer-${suffix}`

const created: Record<string, string[]> = {
  quote: [],
  requisition: [],
  vendor: [],
  policy: [],
}

const sourcing = new SourcingService(new EventEmitterService())
const policyService = new PolicyService()

afterAll(async () => {
  await db.quote.deleteMany({ where: { id: { in: created.quote } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.vendor.deleteMany({ where: { id: { in: created.vendor } } })
  await db.policy.deleteMany({ where: { id: { in: created.policy } } })
  await db.$disconnect()
})

beforeAll(async () => {
  const prior = await policyService.latest('evaluationCriterion', false)
  const policy = await policyService.create({
    name: `Award ${suffix}`,
    kind: 'evaluationCriterion',
    updatedBy: actor,
    config: { criterion: 'bestValue', priceWeight: 0.6 },
    supersedesId: prior?.id ?? null,
  })
  created.policy.push(policy.id)
})

async function makeApprovedRequisition(tag: string) {
  const requisition = await db.requisition.create({
    data: {
      requestNumber: `REQ-Q-${tag}-${suffix}`,
      requestedBy: actor,
      status: 'approved',
      costCenter: 'eng',
      submittedAt: new Date(),
      decidedAt: new Date(),
    },
  })
  created.requisition.push(requisition.id)
  return requisition
}

async function makeVendor(name: string) {
  const vendor = await db.vendor.create({
    data: { name: `${name} ${suffix}`, status: 'active' },
  })
  created.vendor.push(vendor.id)
  return vendor
}

describe('sourcing quotes (§8.1)', () => {
  it('runs request → receive → award exclusively, emitting the outbox event', async () => {
    const requisition = await makeApprovedRequisition('a')
    const [cheap, pricey] = [
      await makeVendor('CheapCo'),
      await makeVendor('PriceyCo'),
    ]

    // Refuses non-approved requisitions.
    const draft = await db.requisition.create({
      data: {
        requestNumber: `REQ-Q-draft-${suffix}`,
        requestedBy: actor,
        status: 'draft',
        costCenter: 'eng',
      },
    })
    created.requisition.push(draft.id)
    await expect(
      sourcing.request(draft.id, [cheap.id], actor),
    ).rejects.toBeInstanceOf(ConflictException)

    // Open two RFQs; re-request is idempotent per vendor.
    const first = await sourcing.request(requisition.id, [cheap.id], actor)
    const again = await sourcing.request(requisition.id, [cheap.id], actor)
    expect(again).toHaveLength(1)
    expect(again[0].id).toBe(first[0].id)

    const both = await sourcing.request(
      requisition.id,
      [cheap.id, pricey.id],
      actor,
    )
    for (const q of both) created.quote.push(q.id)
    expect(both.every((q) => q.status === 'requested')).toBe(true)

    // Offers arrive (any intake channel); totals are minor units.
    await sourcing.receive(first[0].id, {
      totalMinor: 500_000,
      leadTimeDays: 3,
      lines: [{ description: 'laptops', quantity: 5, amountMinor: 500_000 }],
    })
    const cheapQuote = both.find((q) => q.vendorId === cheap.id)
    if (!cheapQuote) throw new Error('expected cheap quote')
    const priceyQuote = both.find((q) => q.vendorId === pricey.id)
    if (!priceyQuote) throw new Error('expected pricey quote')

    await sourcing.receive(cheapQuote.id, {
      totalMinor: 480_000,
    })
    await sourcing.receive(priceyQuote.id, {
      totalMinor: 520_000,
      leadTimeDays: 1,
    })

    // Compare under bestValue policy: deterministic scores, cheaper wins price component.
    const comparison = await sourcing.compare(requisition.id)
    expect(comparison.criterion).toBe('bestValue')
    expect(comparison.ranking).toHaveLength(2)
    const byId = new Map(comparison.ranking.map((r) => [r.quoteId, r.score]))
    const cheapScore = byId.get(cheapQuote.id)
    const priceyScore = byId.get(priceyQuote.id)
    if (cheapScore == null || priceyScore == null) {
      throw new Error('expected both quotes ranked')
    }
    expect(cheapScore).toBeGreaterThan(priceyScore)

    // Award the cheaper quote — siblings rejected in the same transaction.
    const awarded = await sourcing.award(cheapQuote.id, actor)
    expect(awarded.status).toBe('accepted')
    expect(awarded.awardedAt).toBeTruthy()
    const sibling = await sourcing.detail(priceyQuote.id)
    expect(sibling.status).toBe('rejected')
    expect(sibling.rejectedReason).toMatch(/not selected/)

    // Outbox event for wake/analytics.
    const event = await db.domainEvent.findFirst({
      where: { type: 'quote.awarded', entityId: cheapQuote.id },
    })
    expect(event).toBeTruthy()
    if (!event) throw new Error('expected quote.awarded event')
    expect(event.payload).toMatchObject({
      criterion: 'bestValue',
      awardedBy: actor,
    })

    // Awarding again conflicts.
    await expect(sourcing.award(cheapQuote.id, actor)).rejects.toBeInstanceOf(
      ConflictException,
    )
    await expect(sourcing.award(priceyQuote.id, actor)).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('keeps awards exclusive under concurrent attempts', async () => {
    const requisition = await makeApprovedRequisition('race')
    const [vendorA, vendorB] = [
      await makeVendor('RaceA'),
      await makeVendor('RaceB'),
    ]
    const quotes = await sourcing.request(
      requisition.id,
      [vendorA.id, vendorB.id],
      actor,
    )
    for (const q of quotes) created.quote.push(q.id)
    await sourcing.receive(quotes[0].id, { totalMinor: 100_000 })
    await sourcing.receive(quotes[1].id, { totalMinor: 110_000 })

    const results = await Promise.allSettled([
      sourcing.award(quotes[0].id, actor),
      sourcing.award(quotes[1].id, actor),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
      ),
    ).toHaveLength(1)
    const accepted = await db.quote.count({
      where: { requisitionId: requisition.id, status: 'accepted' },
    })
    expect(accepted).toBe(1)
  })

  it('respects a superseding evaluationCriterion policy (latest version wins)', async () => {
    const prior = await policyService.latest('evaluationCriterion', false)
    const offPolicy = await policyService.create({
      name: `Award-lc ${suffix}`,
      kind: 'evaluationCriterion',
      updatedBy: actor,
      config: { criterion: 'lowestCost' },
      supersedesId: prior?.id ?? null,
    })
    created.policy.push(offPolicy.id)

    const requisition = await makeApprovedRequisition('b')
    const vendor = await makeVendor('SoloCo')
    const quotes = await sourcing.request(requisition.id, [vendor.id], actor)
    for (const q of quotes) created.quote.push(q.id)
    await sourcing.receive(quotes[0].id, { totalMinor: 123_000 })

    const comparison = await sourcing.compare(requisition.id)
    expect(comparison.criterion).toBe('lowestCost')
    expect(comparison.recommendedQuoteId).toBe(quotes[0].id)
  })
})
