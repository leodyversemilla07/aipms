import { randomUUID } from 'node:crypto'
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
 * Database leases coordinate multiple API replicas. Delivery remains
 * at-least-once: a stale lease is reclaimed after EVENT_RELAY_LEASE_MS, so
 * handlers must be idempotent. A broker can replace the polling loop later
 * without changing the emit/subscribe API.
 */
@Injectable()
export class EventRelayService implements OnModuleInit, OnModuleDestroy {
  private handlers = new Map<string, EventHandler[]>()
  private interval: ReturnType<typeof setInterval> | null = null
  private polling = false
  private readonly workerId = randomUUID()

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
      const leaseMs = Math.max(
        1_000,
        Number(process.env.EVENT_RELAY_LEASE_MS) || 300_000,
      )
      const staleBefore = new Date(Date.now() - leaseMs)
      const events = await db.domainEvent.findMany({
        where: {
          publishedAt: null,
          deadLetteredAt: null,
          OR: [
            { processingAt: null },
            { processingAt: { lt: staleBefore } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      })

      for (const candidate of events) {
        // Candidate reads are intentionally optimistic. The conditional claim
        // decides ownership across all API replicas before any handler runs.
        const claimed = await db.domainEvent.updateMany({
          where: {
            id: candidate.id,
            publishedAt: null,
            deadLetteredAt: null,
            OR: [
              { processingAt: null },
              { processingAt: { lt: staleBefore } },
            ],
          },
          data: { processingAt: new Date(), processingBy: this.workerId },
        })
        if (claimed.count !== 1) continue

        const event = candidate
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
    await db.domainEvent.updateMany({
      where: { id, processingBy: this.workerId },
      data: {
        publishedAt: new Date(),
        processingAt: null,
        processingBy: null,
      },
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
    const changed = await db.domainEvent.updateMany({
      where: { id, processingBy: this.workerId },
      data: {
        attemptCount: { increment: 1 },
        lastError: message,
      },
    })
    if (changed.count !== 1) return // lease was reclaimed by another worker

    const event = await db.domainEvent.findUniqueOrThrow({
      where: { id },
      select: { attemptCount: true },
    })
    console.error(
      `[event-relay] handler error for event#${id} (attempt ${event.attemptCount}/${maxAttempts}):`,
      message,
    )
    if (event.attemptCount >= maxAttempts) {
      await db.domainEvent.updateMany({
        where: { id, processingBy: this.workerId },
        data: {
          deadLetteredAt: new Date(),
          deadLetterReason: `exceeded ${maxAttempts} delivery attempts: ${message}`,
          processingAt: null,
          processingBy: null,
        },
      })
      console.error(`[event-relay] event#${id} dead-lettered`)
    } else {
      // Release immediately for the next retry pass; failures do not hold a
      // lease until timeout.
      await db.domainEvent.updateMany({
        where: { id, processingBy: this.workerId },
        data: { processingAt: null, processingBy: null },
      })
    }
  }
}
