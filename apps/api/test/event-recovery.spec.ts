import { createHash, randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'
import { EventSubscriptionRouter } from '../src/shared/events/event-subscription.router'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../src/trpc/context.types'

const actorId = `event-recovery-${randomUUID()}`
const createdIds: string[] = []
const idempotencyKeys: string[] = []
const router = new EventSubscriptionRouter(
  new IdempotencyService(),
  new AuditService(),
)
const ctx = {
  actorKind: 'human',
  user: { id: actorId, role: 'finance' },
} as AuthedTrpcContext

afterAll(async () => {
  await db.idempotencyKey.deleteMany({
    where: { key: { in: idempotencyKeys } },
  })
  await db.domainEvent.deleteMany({ where: { id: { in: createdIds } } })
})

function recoveryKey() {
  const supplied = randomUUID()
  idempotencyKeys.push(
    `atomic:v1:${createHash('sha256')
      .update(JSON.stringify([actorId, 'events.requeue', supplied]))
      .digest('hex')}`,
  )
  return supplied
}

describe('domain event recovery', () => {
  it('lists dead letters without exposing payloads and requeues with an audit', async () => {
    const event = await db.domainEvent.create({
      data: {
        type: 'invoice.received',
        entityType: 'Invoice',
        entityId: `invoice-${randomUUID()}`,
        payload: { secret: 'must-not-leak-to-console' },
        attemptCount: 5,
        lastError: 'subscriber unavailable',
        deadLetteredAt: new Date(),
        deadLetterReason: 'Maximum delivery attempts exceeded',
        dispatchClaimId: 'abandoned-claim',
        dispatchClaimedAt: new Date(),
      },
    })
    createdIds.push(event.id)

    const listed = await router.deadLetters({
      q: event.id,
      sort: '',
      dir: 'asc',
      page: 1,
      pageSize: 25,
    })
    expect(listed.total).toBe(1)
    expect(listed.rows[0]).not.toHaveProperty('payload')

    const recovered = await router.requeue(
      {
        id: event.id,
        idempotencyKey: recoveryKey(),
        reason: 'Subscriber repaired and verified healthy',
      },
      ctx,
    )
    expect(recovered.attemptCount).toBe(0)

    const stored = await db.domainEvent.findUniqueOrThrow({
      where: { id: event.id },
    })
    expect(stored).toMatchObject({
      attemptCount: 0,
      lastError: null,
      deadLetteredAt: null,
      deadLetterReason: null,
      dispatchClaimId: null,
      dispatchClaimedAt: null,
    })
    const audit = await db.auditEntry.findFirstOrThrow({
      where: {
        actorId,
        action: 'events.requeue',
        entityId: event.id,
      },
      orderBy: { seq: 'desc' },
    })
    expect(audit.inputHash).toBe(
      new AuditService().hash({
        reason: 'Subscriber repaired and verified healthy',
      }),
    )
    expect(audit.after).toMatchObject({
      recoveryReason: 'Subscriber repaired and verified healthy',
    })
  })

  it('rejects events that are not dead-lettered', async () => {
    const event = await db.domainEvent.create({
      data: {
        type: 'invoice.received',
        entityType: 'Invoice',
        entityId: `invoice-${randomUUID()}`,
        payload: {},
      },
    })
    createdIds.push(event.id)

    await expect(
      router.requeue(
        {
          id: event.id,
          idempotencyKey: recoveryKey(),
          reason: 'Should not be accepted',
        },
        ctx,
      ),
    ).rejects.toThrow('Event is not dead-lettered')
  })
})
