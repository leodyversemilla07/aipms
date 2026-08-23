import { Injectable } from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import type { DomainEventPayload } from './event-types'

/**
 * §13 transactional outbox — emit domain events. Call within a Prisma
 * transaction to guarantee atomicity with the domain mutation.
 */
@Injectable()
export class EventEmitterService {
  /**
   * Emit a domain event. When called with a transaction client, the event
   * is written atomically with the domain state change.
   */
  async emit(
    event: DomainEventPayload,
    tx?: Prisma.TransactionClient | typeof db,
  ) {
    const client = (tx ?? db) as typeof db
    return client.domainEvent.create({
      data: {
        type: event.type,
        entityType: event.entityType,
        entityId: event.entityId,
        payload: event.payload as Prisma.InputJsonObject,
      },
    })
  }
}
