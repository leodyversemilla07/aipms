import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db } from '@workspace/db'
import { AuditService } from '../shared/audit/audit.service'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import { DomainEventTypes } from '../shared/events/event-types'
import {
  assertAgentCapability,
  resolveAgentScopes,
} from '../trpc/agent-capabilities'

/**
 * §10.3 approval SLA escalation — the automation half of "on timeout,
 * escalate one level up". The engine cannot re-route by itself (route
 * membership is a human/admin concern), so escalation here is *visible*:
 * pending approvals that breach the instance SLA window are stamped with
 * escalatedAt and an `approval.slaBreached` domain event fans out through
 * the outbox (agent wake, analytics, future notification surfaces).
 *
 * The SLA window is instance configuration: AIPMS_APPROVAL_SLA_HOURS
 * (default 48). Set it to 0 to disable the poller entirely.
 */

/** The §10.3 breach event — fanned out through the outbox on escalation. */
export const SLA_EVENT_TYPE = DomainEventTypes['approval.slaBreached']

export function resolveSlaHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIPMS_APPROVAL_SLA_HOURS
  if (raw === undefined) return 48
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 48
}

@Injectable()
export class ApprovalSlaService implements OnModuleInit, OnModuleDestroy {
  private interval: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly events: EventEmitterService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    const hours = resolveSlaHours()
    if (hours === 0) {
      console.log('[approval-sla] disabled — AIPMS_APPROVAL_SLA_HOURS=0')
      return
    }
    // Poll hourly regardless of window size; breaches only need hour precision.
    this.interval = setInterval(
      () =>
        void this.sweep().catch((error) =>
          console.error('[approval-sla] sweep failed:', error),
        ),
      3_600_000,
    )
    console.log(`[approval-sla] escalating pending approvals after ${hours}h`)
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval)
  }

  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0
    this.running = true
    const actorId = 'agent:approval-sla'
    try {
      try {
        assertAgentCapability(
          'approval.escalateOverdue',
          resolveAgentScopes(process.env),
        )
      } catch (error) {
        await this.audit.record({
          actorId,
          actorKind: 'agent',
          action: 'approval.escalateOverdue.denied',
          entity: 'Authorization',
          entityId: 'approval.escalateOverdue',
          input: { source: 'scheduler' },
          after: { error: this.errorMessage(error) },
        })
        throw error
      }

      const hours = resolveSlaHours()
      if (hours === 0) return 0
      const cutoff = new Date(now.getTime() - hours * 3_600_000)
      const overdue = await db.approval.findMany({
        where: {
          status: 'pending',
          escalatedAt: null,
          createdAt: { lt: cutoff },
        },
        select: { id: true },
      })

      let escalated = 0
      for (const approval of overdue) {
        const changed = await db.$transaction(async (tx) => {
          // Guard against a decision landing between select and update.
          const updated = await tx.approval.updateMany({
            where: { id: approval.id, status: 'pending', escalatedAt: null },
            data: { escalatedAt: now },
          })
          if (updated.count === 0) return false
          await this.events.emit(
            {
              type: SLA_EVENT_TYPE,
              entityType: 'Approval',
              entityId: approval.id,
              payload: { breachedAt: now.toISOString(), slaHours: hours },
            },
            tx,
          )
          await this.audit.record(
            {
              actorId,
              actorKind: 'agent',
              action: 'approval.escalateOverdue',
              entity: 'Approval',
              entityId: approval.id,
              input: {
                slaHours: hours,
                cutoff: cutoff.toISOString(),
                source: 'scheduler',
              },
              after: { escalatedAt: now.toISOString() },
            },
            tx,
          )
          return true
        })
        if (changed) escalated += 1
      }
      if (escalated > 0) {
        console.log(`[approval-sla] escalated ${escalated} overdue approval(s)`)
      }
      return escalated
    } catch (error) {
      await this.audit.record({
        actorId,
        actorKind: 'agent',
        action: 'approval.escalateOverdue.failed',
        entity: 'Approval',
        entityId: null,
        input: { source: 'scheduler', at: now.toISOString() },
        after: { error: this.errorMessage(error) },
      })
      throw error
    } finally {
      this.running = false
    }
  }

  private errorMessage(error: unknown) {
    return error instanceof Error
      ? error.message.slice(0, 500)
      : 'Unknown error'
  }
}
