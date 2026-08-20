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
 * Delivery is at-least-once with retry + dead-lettering: an event is only
 * marked published when every handler succeeds; a failing event keeps its
 * attempt counter and, after EVENT_RELAY_MAX_ATTEMPTS (default 5), is
 * dead-lettered so one poison event cannot block the queue forever.
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

  /** Poll the outbox once (test seam; the interval calls this on a loop). */
  async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const events = await db.domainEvent.findMany({
        where: { publishedAt: null, deadLetteredAt: null },
        orderBy: { createdAt: 'asc' },
        take: 50,
      })

      for (const event of events) {
        const handlers = this.handlers.get(event.type) ?? []
        if (handlers.length === 0) {
          await this.markPublished(event.id)
          continue
        }
        try {
          for (const handler of handlers) {
            await handler({
              id: event.id,
              type: event.type,
              entityType: event.entityType,
              entityId: event.entityId,
              payload: event.payload as Record<string, unknown>,
              createdAt: event.createdAt,
            })
          }
          await this.markPublished(event.id)
        } catch (err) {
          await this.recordFailure(event.id, err)
        }
      }
    } catch (err) {
      console.error('[event-relay] poll error:', err)
    } finally {
      this.polling = false
    }
  }

  private async markPublished(id: string) {
    await db.domainEvent.update({
      where: { id },
      data: { publishedAt: new Date() },
    })
  }

  /**
   * Bump the attempt counter and record the error. When attempts exhaust
   * EVENT_RELAY_MAX_ATTEMPTS the event is dead-lettered (stops being polled)
   * — an operator can inspect `deadLetterReason`/`lastError` and re-queue by
   * clearing the marker.
   */
  private async recordFailure(id: string, err: unknown) {
    const maxAttempts = Number(process.env.EVENT_RELAY_MAX_ATTEMPTS ?? 5)
    const message =
      err instanceof Error ? err.message : JSON.stringify(err ?? 'unknown')
    const event = await db.domainEvent.update({
      where: { id },
      data: {
        attemptCount: { increment: 1 },
        lastError: message,
      },
      select: { attemptCount: true },
    })
    console.error(
      `[event-relay] handler error for event#${id} (attempt ${event.attemptCount}/${maxAttempts}):`,
      message,
    )
    if (event.attemptCount >= maxAttempts) {
      await db.domainEvent.update({
        where: { id },
        data: {
          deadLetteredAt: new Date(),
          deadLetterReason: `exceeded ${maxAttempts} delivery attempts: ${message}`,
        },
      })
      console.error(`[event-relay] event#${id} dead-lettered`)
    }
  }
}