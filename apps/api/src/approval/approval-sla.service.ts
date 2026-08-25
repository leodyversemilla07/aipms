import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import { DomainEventTypes } from '../shared/events/event-types'

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

  constructor(private readonly events: EventEmitterService) {}

  onModuleInit() {
    const hours = resolveSlaHours()
    if (hours === 0) {
      console.log('[approval-sla] disabled — AIPMS_APPROVAL_SLA_HOURS=0')
      return
    }
    // Poll hourly regardless of window size; breaches only need hour precision.
    this.interval = setInterval(() => void this.sweep(), 3_600_000)
    console.log(`[approval-sla] escalating pending approvals after ${hours}h`)
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval)
  }

  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
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

      for (const approval of overdue) {
        await db.$transaction(async (tx) => {
          // Guard against a decision landing between select and update.
          const updated = await tx.approval.updateMany({
            where: { id: approval.id, status: 'pending', escalatedAt: null },
            data: { escalatedAt: now },
          })
          if (updated.count > 0) {
            await this.events.emit(
              {
                type: SLA_EVENT_TYPE,
                entityType: 'Approval',
                entityId: approval.id,
                payload: { breachedAt: now.toISOString(), slaHours: hours },
              },
              tx,
            )
          }
        })
      }
      if (overdue.length > 0) {
        console.log(
          `[approval-sla] escalated ${overdue.length} overdue approval(s)`,
        )
      }
      return overdue.length
    } finally {
      this.running = false
    }
  }
}
