import {
  ConflictException,
  Injectable,
  OnModuleInit,
  Optional,
} from '@nestjs/common'
import { db, Prisma, type VendorModel as Vendor } from '@workspace/db'
import { evaluateThresholdGate } from '../policy/policy-engine'
import { resolveEffectivePolicy } from '../policy/policy-resolver'
import { EventRelayService } from '../shared/events/event-relay.service'
import { AgentCommandService } from './agent-command.service'
import { configuredAgentId } from './agent-principal'
import { AgentRuntimeService } from './agent-runtime.service'

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
 * with AGENT_AUTORUN=1 or AIPMS_AGENT_WAKE=1.
 *
 * Two wake targets:
 *
 * - The in-process deterministic pipeline (default). The API performs the
 *   work itself through the shared command boundary.
 * - The eve agent runtime (`AIPMS_AGENT_EVE_WAKE=1` with
 *   `AIPMS_AGENT_EVE_URL` and `AIPMS_AGENT_ACCESS_TOKEN` configured). This
 *   is the `BUS -.wake.-> EVE` edge of the architecture diagram: the API
 *   creates an eve session, delivers the event as its first message, and
 *   records the session as the agent run. The agent then acts through its
 *   own tools, which call back into the API's command boundary — so every
 *   capability check, quota, and audit rule still applies.
 */
@Injectable()
export class AgentWakeService implements OnModuleInit {
  private readonly db: typeof db
  private readonly eveWakeEnabled = process.env.AIPMS_AGENT_EVE_WAKE === '1'

  constructor(
    private readonly relay: EventRelayService,
    private readonly commands: AgentCommandService,
    private readonly runtime: AgentRuntimeService,
    @Optional()
    dbClient?: typeof db,
  ) {
    this.db = dbClient ?? db
  }

  onModuleInit() {
    const enabled =
      process.env.AGENT_AUTORUN === '1' || process.env.AIPMS_AGENT_WAKE === '1'
    if (!enabled) {
      console.log(
        '[agent-wake] disabled (set AGENT_AUTORUN=1 or AIPMS_AGENT_WAKE=1 to enable unattended event handling)',
      )
      return
    }

    if (this.eveWakeEnabled && !this.runtime.isConfigured()) {
      console.error(
        '[agent-wake] AIPMS_AGENT_EVE_WAKE=1 but AIPMS_AGENT_EVE_URL / AIPMS_AGENT_ACCESS_TOKEN are not configured; using the in-process pipeline',
      )
    }

    // Wake on requisition approval → operator agent should issue PO
    this.relay.subscribe('requisition.approved', async (event) => {
      if (
        await this.wakeAgentIfEnabled(
          event,
          ['requisition-to-po'],
          this.requisitionWakeMessage(event),
        )
      ) {
        return
      }
      await this.handleRequisitionApproved(event)
    })

    // Invoice registration already runs the deterministic match in-transaction.
    // Do not report a successful agent run for an event with no agent work.

    // Wake on intake received → classify document
    this.relay.subscribe('intake.received', async (event) => {
      if (
        await this.wakeAgentIfEnabled(
          event,
          ['intake-classify'],
          this.intakeWakeMessage(event),
        )
      ) {
        return
      }
      await this.spawnRun('operator', ['intake-classify'], event)
    })
  }

  /**
   * Hand the event to the eve runtime. Returns false when the in-process
   * pipeline owns the event instead.
   */
  private async wakeAgentIfEnabled(
    event: RelayedEvent,
    skills: string[],
    message: string,
  ): Promise<boolean> {
    if (!this.eveWakeEnabled || !this.runtime.isConfigured()) return false
    // The operation id is stable per event, so a redelivered event returns
    // the same eve session instead of waking the agent twice.
    const operationId = `wake:${event.id}`
    const delivery = await this.runtime.wake({ message, operationId })
    await this.beginRun(configuredAgentId(), skills, event, {
      id: delivery.sessionId,
      meta: {
        delivery: {
          channel: 'eve',
          sessionId: delivery.sessionId,
          deliveryId: delivery.deliveryId ?? null,
          operationId,
        },
      },
    })
    console.log(
      `[agent-wake] woke eve session ${delivery.sessionId} for ${event.type}`,
    )
    return true
  }

  private requisitionWakeMessage(event: RelayedEvent) {
    return (
      `Domain event ${event.type} fired for requisition ${event.entityId}. ` +
      'The requisition is approved and needs a purchase order. Use your aipms ' +
      'tools to issue the purchase order for it, then close this run with ' +
      'complete_agent_run.'
    )
  }

  private intakeWakeMessage(event: RelayedEvent) {
    return (
      `Domain event ${event.type} fired for intake document ${event.entityId}. ` +
      'The document is pending classification and registration. Use your aipms ' +
      'tools to process it, then close this run with complete_agent_run.'
    )
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
      const requisition = await this.db.requisition.findUnique({
        where: { id: event.entityId },
        include: { lines: true },
      })
      if (!requisition) throw new Error('Requisition not found')

      // Crash recovery: check if an uncancelled PO was already issued for this
      // requisition during a prior interrupted wake attempt.
      const existingPo = await this.db.purchaseOrder.findFirst({
        where: {
          requisitionId: requisition.id,
          status: { not: 'cancelled' },
        },
      })
      if (existingPo) {
        console.log(
          `[agent-wake] run ${run.id} recovered already-issued PO ${existingPo.poNumber}`,
        )
        await this.db.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            meta: {
              ...(run.meta as Prisma.InputJsonObject),
              recovered: true,
              result: {
                outcome: 'ISSUED',
                purchaseOrderId: existingPo.id,
                poNumber: existingPo.poNumber,
              },
            },
          },
        })
        return
      }

      // Threshold gate for auto-issue: reuse the same policy engine the
      // requisition submit path uses (§11). Conservative by default — no
      // applicable policy means human review, never silent auto-issue.
      const totalMinor = requisition.lines.reduce(
        (sum, l) => sum + l.lineTotalMinor,
        0,
      )
      const thresholdPolicy = await resolveEffectivePolicy(
        'threshold',
        {
          costCenter: requisition.costCenter,
        },
        this.db,
      )
      let budgetRemainingMinor: number | undefined
      if (requisition.budgetId) {
        const budget = await this.db.budget.findUnique({
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
        await this.db.agentRun.update({
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
      const awardedQuote = await this.db.quote.findFirst({
        where: { requisitionId: requisition.id, status: 'accepted' },
      })
      if (awardedQuote) {
        vendor = await this.db.vendor.findUnique({
          where: { id: awardedQuote.vendorId },
        })
      }
      const prefPolicy = vendor
        ? null
        : await resolveEffectivePolicy(
            'preferredVendor',
            {
              costCenter: requisition.costCenter,
            },
            this.db,
          )
      if (!vendor && prefPolicy?.config) {
        const cfg = prefPolicy.config as PreferredVendorConfig
        const vendorId = cfg.vendorId ?? cfg.vendor_id
        if (vendorId) {
          vendor = await this.db.vendor.findUnique({ where: { id: vendorId } })
          if (!vendor)
            throw new Error(
              'Configured preferred vendor is unavailable; refusing arbitrary fallback',
            )
        }
      }
      if (!vendor) {
        // Fallback to first active vendor
        vendor = await this.db.vendor.findFirst({ where: { status: 'active' } })
      }
      if (!vendor) throw new Error('No active vendor found')
      const result = await this.commands.issuePurchaseOrder(
        { requisitionId: requisition.id, vendorId: vendor.id, terms: {} },
        {
          id: configuredAgentId(),
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
      await this.db.agentRun.update({
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
      if (
        (err instanceof ConflictException ||
          (err instanceof Error && err.name === 'ConflictException')) &&
        typeof (err as Error).message === 'string' &&
        (err as Error).message.includes('already has a purchase order')
      ) {
        const recoveredPo = await this.db.purchaseOrder.findFirst({
          where: {
            requisitionId: event.entityId,
            status: { not: 'cancelled' },
          },
        })
        if (recoveredPo) {
          console.log(
            `[agent-wake] run ${run.id} recovered already-issued PO ${recoveredPo.poNumber} on conflict retry`,
          )
          await this.db.agentRun.update({
            where: { id: run.id },
            data: {
              status: 'succeeded',
              finishedAt: new Date(),
              meta: {
                ...(run.meta as Prisma.InputJsonObject),
                recovered: true,
                result: {
                  outcome: 'ISSUED',
                  purchaseOrderId: recoveredPo.id,
                  poNumber: recoveredPo.poNumber,
                },
              },
            },
          })
          return
        }
      }
      console.error(`[agent-wake] run ${run.id} failed`, err)
      await this.db.agentRun.update({
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
          id: configuredAgentId(),
          kind: 'agent',
          runId: run.id,
          idempotencyKey: `event:${event.id}`,
          source: 'event-wake',
        })
        console.log(
          `[agent-wake] run ${run.id} processed intake ${event.entityId}`,
        )
        await this.db.agentRun.update({
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
      await this.db.agentRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', finishedAt: new Date() },
      })
    } catch (err) {
      console.error(`[agent-wake] run ${run.id} failed`, err)
      await this.db.agentRun.update({
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
   *
   * `options.id` pins the run id to the eve session id, so the agent's tool
   * calls (which carry that session id as their run claim) resolve to this
   * exact run.
   */
  private async beginRun(
    agentId: string,
    skills: string[],
    event: RelayedEvent,
    options: {
      id?: string
      meta?: Record<string, unknown>
    } = {},
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
        ...(options.meta ?? {}),
      },
    }
    try {
      const run = await this.db.agentRun.create({
        data: { ...data, ...(options.id ? { id: options.id } : {}) },
      })
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

    const existing = await this.db.agentRun.findUnique({
      where: { triggerEventId: event.id },
    })
    if (!existing) throw new Error(`Run for event ${event.id} disappeared`)
    if (existing.status === 'succeeded') {
      return { run: existing, shouldProcess: false as const }
    }
    const run = await this.db.agentRun.update({
      where: { id: existing.id },
      data: { status: 'running', finishedAt: null, meta: data.meta },
    })
    console.log(`[agent-wake] retrying run ${run.id} for ${event.type}`)
    return { run, shouldProcess: true as const }
  }
}
