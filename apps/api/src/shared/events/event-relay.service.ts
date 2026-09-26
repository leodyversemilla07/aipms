import { randomUUID } from 'node:crypto'
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import type { DomainEventType } from './event-types'

type RelayedEvent = {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: unknown
  createdAt: Date
}

type EventHandler = (event: {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  createdAt: Date
}) => Promise<void>

/**
 * §13 transactional-outbox relay with at-least-once delivery. A durable,
 * expiring database claim ensures only one API replica dispatches an event at
 * a time. Events are published only after every handler succeeds; failures
 * retry and eventually dead-letter without blocking the rest of the queue.
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
      const { claimId, events } = await this.claimBatch()
      for (const event of events) {
        const handlers = this.handlers.get(event.type) ?? []
        if (handlers.length === 0) {
          await this.markPublished(event.id, claimId)
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
          await this.markPublished(event.id, claimId)
        } catch (error) {
          await this.recordFailure(event.id, claimId, error)
        }
      }
    } catch (error) {
      console.error('[event-relay] poll error:', error)
    } finally {
      this.polling = false
    }
  }

  private async claimBatch(): Promise<{
    claimId: string
    events: RelayedEvent[]
  }> {
    const claimId = randomUUID()
    const configuredLeaseMs = Number(
      process.env.EVENT_RELAY_CLAIM_TTL_MS ?? 900_000,
    )
    const leaseMs =
      Number.isFinite(configuredLeaseMs) && configuredLeaseMs >= 1000
        ? configuredLeaseMs
        : 900_000
    const staleBefore = new Date(Date.now() - leaseMs)
    const events = await db.$transaction((tx) =>
      tx.$queryRaw<RelayedEvent[]>(Prisma.sql`
        UPDATE "domainEvent" AS event
        SET
          "dispatchClaimId" = ${claimId},
          "dispatchClaimedAt" = NOW()
        FROM (
          SELECT "id"
          FROM "domainEvent"
          WHERE "publishedAt" IS NULL
            AND "deadLetteredAt" IS NULL
            AND (
              "dispatchClaimId" IS NULL
              OR "dispatchClaimedAt" IS NULL
              OR "dispatchClaimedAt" < ${staleBefore}
            )
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 50
        ) AS claimable
        WHERE event."id" = claimable."id"
        RETURNING
          event."id",
          event."type",
          event."entityType",
          event."entityId",
          event."payload",
          event."createdAt"
      `),
    )
    return { claimId, events }
  }

  private async markPublished(id: string, claimId: string) {
    const updated = await db.domainEvent.updateMany({
      where: { id, dispatchClaimId: claimId, publishedAt: null },
      data: {
        publishedAt: new Date(),
        dispatchClaimId: null,
        dispatchClaimedAt: null,
      },
    })
    if (updated.count !== 1) {
      throw new Error(`Lost event relay claim for ${id}`)
    }
  }

  /**
   * Release the claim and record the failed delivery. Exhausted events are
   * dead-lettered; operators can inspect the stored reason and explicitly
   * requeue them by clearing the marker.
   */
  private async recordFailure(id: string, claimId: string, error: unknown) {
    const configuredMax = Number(process.env.EVENT_RELAY_MAX_ATTEMPTS ?? 5)
    const maxAttempts =
      Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : 5
    const message =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : String(error ?? 'unknown').slice(0, 1000)
    const attemptCount = await db.$transaction(async (tx) => {
      const claimed = await tx.domainEvent.findFirst({
        where: { id, dispatchClaimId: claimId },
        select: { attemptCount: true },
      })
      if (!claimed) throw new Error(`Lost event relay claim for ${id}`)
      const nextAttempt = claimed.attemptCount + 1
      await tx.domainEvent.update({
        where: { id },
        data: {
          attemptCount: nextAttempt,
          lastError: message,
          dispatchClaimId: null,
          dispatchClaimedAt: null,
          ...(nextAttempt >= maxAttempts
            ? {
                deadLetteredAt: new Date(),
                deadLetterReason: `exceeded ${maxAttempts} delivery attempts: ${message}`,
              }
            : {}),
        },
      })
      return nextAttempt
    })
    console.error(
      `[event-relay] handler error for event#${id} (attempt ${attemptCount}/${maxAttempts}):`,
      message,
    )
    if (attemptCount >= maxAttempts) {
      console.error(`[event-relay] event#${id} dead-lettered`)
    }
  }
}
