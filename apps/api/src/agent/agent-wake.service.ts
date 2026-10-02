import { Injectable, OnModuleInit } from '@nestjs/common'
import { db, Prisma, type VendorModel as Vendor } from '@workspace/db'
import { evaluateThresholdGate } from '../policy/policy-engine'
import { resolveEffectivePolicy } from '../policy/policy-resolver'
import { EventRelayService } from '../shared/events/event-relay.service'
import { AgentCommandService } from './agent-command.service'

/** Shape the relay hands to handlers (§13 outbox rows). */
interface RelayedEvent {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  createdAt: Date
}

/** PreferredVendor policy config (§11 — config as data). */
interface PreferredVendorConfig {
  vendorId?: string
  vendor_id?: string
}

/** Cast an arbitrary plain value to a writable Prisma JSON field. */
const asJson = (value: unknown): Prisma.InputJsonObject =>
  value as Prisma.InputJsonObject
/**
 * §7.3 Agent wake — listens to domain events and spawns an agent run
 * for events that require automated handling. Disabled by default; enable
 * with AGENT_AUTORUN=1 or AIPMS_AGENT_WAKE=1. This is a thin orchestrator
 * stub; real skill routing will be expanded in Phase 3+.
 */
@Injectable()
export class AgentWakeService implements OnModuleInit {
  constructor(
    private readonly relay: EventRelayService,
    private readonly commands: AgentCommandService,
  ) {}

  onModuleInit() {
    const enabled =
      process.env.AGENT_AUTORUN === '1' || process.env.AIPMS_AGENT_WAKE === '1'
    if (!enabled) {
      console.log(
        '[agent-wake] disabled (set AGENT_AUTORUN=1 or AIPMS_AGENT_WAKE=1 to enable unattended event handling)',
      )
      return
    }

    // Wake on requisition approval → operator agent should issue PO
    this.relay.subscribe('requisition.approved', async (event) => {
      await this.handleRequisitionApproved(event)
    })

    // Invoice registration already runs the deterministic match in-transaction.
    // Do not report a successful agent run for an event with no agent work.

    // Wake on intake received → classify document
    this.relay.subscribe('intake.received', async (event) => {
      await this.spawnRun('operator', ['intake-classify'], event)
    })
  }

  private async handleRequisitionApproved(event: RelayedEvent) {
    const started = await this.beginRun(
      'operator',
      ['requisition-to-po'],
      event,
    )
    if (!started.shouldProcess) return
    const run = started.run
    try {
      const requisition = await db.requisition.findUnique({
        where: { id: event.entityId },
        include: { lines: true },
      })
      if (!requisition) throw new Error('Requisition not found')
      // Threshold gate for auto-issue: reuse the same policy engine the
      // requisition submit path uses (§11). Conservative by default — no
      // applicable policy means human review, never silent auto-issue.
      const totalMinor = requisition.lines.reduce(
        (sum, l) => sum + l.lineTotalMinor,
        0,
      )
      const thresholdPolicy = await resolveEffectivePolicy('threshold', {
        costCenter: requisition.costCenter,
      })
      let budgetRemainingMinor: number | undefined
      if (requisition.budgetId) {
        const budget = await db.budget.findUnique({
          where: { id: requisition.budgetId },
        })
        if (budget) {
          budgetRemainingMinor =
            budget.limitMinor - budget.committedMinor - budget.spentMinor
        }
      }
      const decision = evaluateThresholdGate(thresholdPolicy ?? undefined, {
        costCenter: requisition.costCenter,
        amountMinor: totalMinor,
        budgetAssigned: Boolean(requisition.budgetId),
        budgetRemainingMinor,
      })
      if (decision.outcome !== 'PASS') {
        console.log(
          `[agent-wake] run ${run.id} skipped auto PO: ${decision.reason}`,
        )
        await db.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            meta: {
              ...(run.meta as Prisma.InputJsonObject),
              skipped: decision.outcome,
              totalMinor,
              decision: asJson(decision),
            },
          },
        })
        return
      }
      // A sourcing award is authoritative. Unsourced requisitions fall back
      // to preferred-vendor policy, then the active vendor pool.
      let vendor: Vendor | null = null
      const awardedQuote = await db.quote.findFirst({
        where: { requisitionId: requisition.id, status: 'accepted' },
      })
      if (awardedQuote) {
        vendor = await db.vendor.findUnique({
          where: { id: awardedQuote.vendorId },
        })
      }
      const prefPolicy = vendor
        ? null
        : await resolveEffectivePolicy('preferredVendor', {
            costCenter: requisition.costCenter,
          })
      if (!vendor && prefPolicy?.config) {
        const cfg = prefPolicy.config as PreferredVendorConfig
        const vendorId = cfg.vendorId ?? cfg.vendor_id
        if (vendorId) {
          vendor = await db.vendor.findUnique({ where: { id: vendorId } })
          if (!vendor)
            throw new Error(
              'Configured preferred vendor is unavailable; refusing arbitrary fallback',
            )
        }
      }
      if (!vendor) {
        // Fallback to first active vendor
        vendor = await db.vendor.findFirst({ where: { status: 'active' } })
      }
      if (!vendor) throw new Error('No active vendor found')
      const result = await this.commands.issuePurchaseOrder(
        { requisitionId: requisition.id, vendorId: vendor.id, terms: {} },
        {
          id: 'agent:operator',
          kind: 'agent',
          runId: run.id,
          idempotencyKey: `event:${event.id}`,
          source: 'event-wake',
        },
      )
      const poNumber =
        'outcome' in result && result.outcome === 'ISSUED'
          ? result.purchaseOrder.poNumber
          : 'N/A'
      console.log(`[agent-wake] run ${run.id} issued PO ${poNumber}`)
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          meta: {
            ...(run.meta as Prisma.InputJsonObject),
            decision: asJson(decision),
            preferredVendorPolicyId: prefPolicy?.id ?? null,
            preferredVendorPolicyVersion: prefPolicy?.version ?? null,
            result:
              result.outcome === 'ISSUED'
                ? {
                    outcome: result.outcome,
                    purchaseOrderId: result.purchaseOrder.id,
                    poNumber: result.purchaseOrder.poNumber,
                  }
                : result,
          },
        },
      })
    } catch (err) {
      console.error(`[agent-wake] run ${run.id} failed`, err)
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          meta: {
            ...(run.meta as Prisma.InputJsonObject),
            error: (err as Error).message,
          },
        },
      })
      // Propagate failures to the outbox relay so retry/dead-letter semantics remain intact.
      throw err
    }
  }

  private async spawnRun(
    agentId: string,
    skills: string[],
    event: RelayedEvent,
  ) {
    const started = await this.beginRun(agentId, skills, event)
    if (!started.shouldProcess) return
    const run = started.run
    try {
      if (event.type === 'intake.received') {
        const result = await this.commands.processDocument(event.entityId, {
          id: 'agent:operator',
          kind: 'agent',
          runId: run.id,
          idempotencyKey: `event:${event.id}`,
          source: 'event-wake',
        })
        console.log(
          `[agent-wake] run ${run.id} processed intake ${event.entityId}`,
        )
        await db.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            meta: {
              ...(run.meta as Prisma.InputJsonObject),
              result: {
                docStatus: result.doc.status,
                invoiceId: (result.invoice as { id?: string }).id,
                matchOutcome: result.match?.outcome,
              },
            },
          },
        })
        return
      }
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', finishedAt: new Date() },
      })
    } catch (err) {
      console.error(`[agent-wake] run ${run.id} failed`, err)
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          meta: {
            ...(run.meta as Prisma.InputJsonObject),
            error: (err as Error).message,
          },
        },
      })
      // Propagate failures to the outbox relay so retry/dead-letter semantics remain intact.
      throw err
    }
  }

  /**
   * At-least-once outbox delivery maps to one durable run. A published event
   * whose final relay acknowledgement was interrupted returns its succeeded
   * run; failed/stale-running runs are reclaimed for retry without creating
   * duplicate trace rows.
   */
  private async beginRun(
    agentId: string,
    skills: string[],
    event: RelayedEvent,
  ) {
    const data = {
      agentId,
      skills,
      triggerEventId: event.id,
      meta: {
        triggeredBy: event.type,
        entityType: event.entityType,
        entityId: event.entityId,
        eventId: event.id,
      },
    }
    try {
      const run = await db.agentRun.create({ data })
      console.log(`[agent-wake] spawned run ${run.id} for ${event.type}`)
      return { run, shouldProcess: true as const }
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error
      }
    }

    const existing = await db.agentRun.findUnique({
      where: { triggerEventId: event.id },
    })
    if (!existing) throw new Error(`Run for event ${event.id} disappeared`)
    if (existing.status === 'succeeded') {
      return { run: existing, shouldProcess: false as const }
    }
    const run = await db.agentRun.update({
      where: { id: existing.id },
      data: { status: 'running', finishedAt: null, meta: data.meta },
    })
    console.log(`[agent-wake] retrying run ${run.id} for ${event.type}`)
    return { run, shouldProcess: true as const }
  }
}
