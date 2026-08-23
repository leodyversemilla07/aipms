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
  /**
   * Parallel suites share the outbox table; a poll batch caps at 50 rows,
   * so keep polling until our event surfaces past any concurrent backlog
   * (delivery is FIFO by createdAt).
   */
  async function pollUntilPublished(
    relay: EventRelayService,
    eventId: string,
    maxPasses = 25,
  ) {
    let row = await db.domainEvent.findUnique({ where: { id: eventId } })
    for (let i = 0; i < maxPasses && !row?.publishedAt; i++) {
      await relay.poll()
      row = await db.domainEvent.findUnique({ where: { id: eventId } })
    }
    return row
  }

  /** Poll until an arbitrary condition on the row holds (bounded). */
  async function pollUntil(
    relay: EventRelayService,
    eventId: string,
    predicate: (
      row: { publishedAt: Date | null; attemptCount: number } | null,
    ) => boolean,
    maxPasses = 25,
  ) {
    let row = await db.domainEvent.findUnique({ where: { id: eventId } })
    for (let i = 0; i < maxPasses && !predicate(row); i++) {
      await relay.poll()
      row = await db.domainEvent.findUnique({ where: { id: eventId } })
    }
    return row
  }

  it('publishes an event once every handler succeeds', async () => {
    const relay = new EventRelayService()
    const seen: string[] = []
    relay.subscribe('requisition.approved', async (event) => {
      seen.push(event.id)
    })
    const event = await makeEvent('requisition.approved', 'ok')

    const row = await pollUntilPublished(relay, event.id)
    expect(row?.publishedAt).not.toBeNull()
    expect(seen).toEqual([event.id])
    expect(row?.attemptCount).toBe(0)

    await relay.poll() // a later pass must be a no-op for published events
    expect(seen).toEqual([event.id])
  })

  it('publishes events with no handlers without waiting on one', async () => {
    const relay = new EventRelayService()
    const event = await makeEvent('intake.received', 'no-handler')

    const row = await pollUntilPublished(relay, event.id)
    expect(row?.publishedAt).not.toBeNull()
  })

  it('retries failing events and dead-letters after max attempts', async () => {
    const relay = new EventRelayService()
    relay.subscribe('invoice.received', async () => {
      throw new Error('downstream is down')
    })
    const event = await makeEvent('invoice.received', 'poison')

    const maxAttempts = Number(process.env.EVENT_RELAY_MAX_ATTEMPTS ?? 5)
    let row = await pollUntil(
      relay,
      event.id,
      (r) => (r?.attemptCount ?? 0) >= maxAttempts - 1,
    )
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

    let row = await pollUntil(
      relay,
      event.id,
      (r) => (r?.attemptCount ?? 0) >= 1 && r?.publishedAt == null,
    )
    expect(row?.publishedAt).toBeNull()
    expect(row?.attemptCount).toBe(1)

    failing = false
    row = await pollUntil(relay, event.id, (r) => r?.publishedAt != null)

    row = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(row?.publishedAt).not.toBeNull()
    expect(row?.attemptCount).toBe(1) // recovery does not bump the counter
  })
})
