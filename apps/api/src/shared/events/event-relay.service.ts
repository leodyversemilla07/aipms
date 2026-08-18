import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db } from '@workspace/db'
import type { DomainEventType } from './event-types'

type EventHandler = (event: {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  createdAt: Date
}) => Promise<void>

/**
 * §13 event relay — polls the transactional outbox for unpublished events
 * and dispatches them to registered handlers. Handlers are registered by
 * domain services or agent-wake services at module init time.
 *
 * This is a database-backed relay suitable for single-tenant, single-node
 * deployment. A message broker (Redis Streams, etc.) can replace the
 * polling loop in Phase 6 without changing the emit/subscribe API.
 */
@Injectable()
export class EventRelayService implements OnModuleInit, OnModuleDestroy {
  private handlers = new Map<string, EventHandler[]>()
  private interval: ReturnType<typeof setInterval> | null = null
  private polling = false

  /** Register a handler for a specific event type. */
  subscribe(type: DomainEventType, handler: EventHandler) {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  onModuleInit() {
    const intervalMs = Number(process.env.EVENT_RELAY_INTERVAL_MS ?? 1000)
    this.interval = setInterval(() => this.poll(), intervalMs)
    console.log(`[event-relay] started polling every ${intervalMs}ms`)
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const events = await db.domainEvent.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 50,
      })

      for (const event of events) {
        const handlers = this.handlers.get(event.type) ?? []
        for (const handler of handlers) {
          try {
            await handler({
              id: event.id,
              type: event.type,
              entityType: event.entityType,
              entityId: event.entityId,
              payload: event.payload as Record<string, unknown>,
              createdAt: event.createdAt,
            })
          } catch (err) {
            console.error(
              `[event-relay] handler error for ${event.type}#${event.id}:`,
              err,
            )
          }
        }
        // Mark as published regardless of handler outcome
        // (failed events are logged; dead-letter queue is Phase 6)
        await db.domainEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date() },
        })
      }
    } catch (err) {
      console.error('[event-relay] poll error:', err)
    } finally {
      this.polling = false
    }
  }
}
