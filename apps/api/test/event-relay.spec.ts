import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { EventRelayService } from '../src/shared/events/event-relay.service'
import type { DomainEventType } from '../src/shared/events/event-types'

/**
 * @workspace event relay (§13) — retry + dead-letter: a failing handler keeps
 * the event unpublished, bumps the attempt counter, and after
 * EVENT_RELAY_MAX_ATTEMPTS the event is dead-lettered; poison events cannot
 * block later deliveries.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const eventIds: string[] = []

afterAll(async () => {
  await db.domainEvent.deleteMany({ where: { id: { in: eventIds } } })
  await db.$disconnect()
})

async function makeEvent(type: DomainEventType, tag: string) {
  const event = await db.domainEvent.create({
    data: {
      type,
      entityType: 'Test',
      entityId: `relay-${suffix}-${tag}`,
      payload: { tag },
    },
  })
  eventIds.push(event.id)
  return event
}

describe('EventRelayService (§13)', () => {
  it('publishes an event once every handler succeeds', async () => {
    const relay = new EventRelayService()
    const seen: string[] = []
    relay.subscribe('requisition.approved', async (event) => {
      seen.push(event.id)
    })
    const event = await makeEvent('requisition.approved', 'ok')

    await relay.poll()
    await relay.poll() // second pass must be a no-op

    const row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).not.toBeNull()
    expect(seen).toEqual([event.id])
    expect(row?.attemptCount).toBe(0)
  })

  it('publishes events with no handlers without waiting on one', async () => {
    const relay = new EventRelayService()
    const event = await makeEvent('intake.received', 'no-handler')

    await relay.poll()

    const row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).not.toBeNull()
  })

  it('retries failing events and dead-letters after max attempts', async () => {
    const relay = new EventRelayService()
    relay.subscribe('invoice.received', async () => {
      throw new Error('downstream is down')
    })
    const event = await makeEvent('invoice.received', 'poison')

    const maxAttempts = Number(process.env.EVENT_RELAY_MAX_ATTEMPTS ?? 5)
    for (let i = 0; i < maxAttempts - 1; i++) {
      await relay.poll()
    }

    let row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).toBeNull()
    expect(row?.deadLetteredAt).toBeNull()
    expect(row?.attemptCount).toBe(maxAttempts - 1)
    expect(row?.lastError).toContain('downstream is down')

    await relay.poll() // one more attempt exhausts the budget

    row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.deadLetteredAt).not.toBeNull()
    expect(row?.deadLetterReason).toContain('exceeded')

    // Dead-lettered events stop being polled entirely.
    await relay.poll()
    row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.attemptCount).toBe(maxAttempts)
  })

  it('recovers once the handler stops failing (before the budget is spent)', async () => {
    const relay = new EventRelayService()
    let failing = true
    relay.subscribe('requisition.approved', async () => {
      if (failing) throw new Error('flaky')
    })
    const event = await makeEvent('requisition.approved', 'flaky')

    await relay.poll()
    let row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).toBeNull()
    expect(row?.attemptCount).toBe(1)

    failing = false
    await relay.poll()

    row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).not.toBeNull()
    expect(row?.attemptCount).toBe(1) // recovery does not bump the counter
  })
})