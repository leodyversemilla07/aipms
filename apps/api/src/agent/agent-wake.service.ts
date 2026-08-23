import { Injectable, OnModuleInit } from '@nestjs/common'
import { db, Prisma, type VendorModel as Vendor } from '@workspace/db'
import { evaluateThresholdGate } from '../policy/policy-engine'
import { PurchaseOrderService } from '../purchase-order/purchase-order.service'
import { EventRelayService } from '../shared/events/event-relay.service'
import { AgentService } from './agent.service'

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
 * for events that require automated handling. This is a thin orchestrator
 * stub; real skill routing will be expanded in Phase 3+.
 */
@Injectable()
export class AgentWakeService implements OnModuleInit {
  constructor(
    private readonly relay: EventRelayService,
    private readonly agent: AgentService,
    private readonly po: PurchaseOrderService,
  ) {}

  onModuleInit() {
    // Wake on requisition approval → operator agent should issue PO
    this.relay.subscribe('requisition.approved', async (event) => {
      await this.handleRequisitionApproved(event)
    })

    // Wake on invoice received → audit/match agent should process intake
    this.relay.subscribe('invoice.received', async (event) => {
      await this.spawnRun('operator', ['invoice-match'], event)
    })

    // Wake on intake received → classify document
    this.relay.subscribe('intake.received', async (event) => {
      await this.spawnRun('operator', ['intake-classify'], event)
    })
  }

  private async handleRequisitionApproved(event: RelayedEvent) {
    const run = await db.agentRun.create({
      data: {
        agentId: 'operator',
        skills: ['requisition-to-po'],
        meta: {
          triggeredBy: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          eventId: event.id,
        },
      },
    })
    console.log(`[agent-wake] spawned run ${run.id} for ${event.type}`)
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
      const thresholdPolicy = await db.policy.findFirst({
        where: { kind: 'threshold', enabled: true },
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
      // Policy-driven vendor selection: preferredVendor policy takes precedence
      let vendor: Vendor | null = null
      const prefPolicy = await db.policy.findFirst({
        where: { kind: 'preferredVendor', enabled: true },
      })
      if (prefPolicy?.config) {
        const cfg = prefPolicy.config as PreferredVendorConfig
        const vendorId = cfg.vendorId ?? cfg.vendor_id
        if (vendorId) {
          vendor = await db.vendor.findUnique({ where: { id: vendorId } })
        }
      }
      if (!vendor) {
        // Fallback to first active vendor
        vendor = await db.vendor.findFirst({ where: { status: 'active' } })
      }
      if (!vendor) throw new Error('No active vendor found')
      const result = await this.po.issue(
        { requisitionId: requisition.id, vendorId: vendor.id, terms: {} },
        'agent-operator',
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
          meta: { ...(run.meta as Prisma.InputJsonObject), result: asJson(result) },
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
    }
  }

  private async spawnRun(
    agentId: string,
    skills: string[],
    event: RelayedEvent,
  ) {
    const run = await db.agentRun.create({
      data: {
        agentId,
        skills,
        meta: {
          triggeredBy: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          eventId: event.id,
        },
      },
    })
    console.log(`[agent-wake] spawned run ${run.id} for ${event.type}`)
    try {
      if (event.type === 'intake.received') {
        const result = await this.agent.processPending(5)
        console.log(
          `[agent-wake] run ${run.id} processed ${result.succeeded}/${result.documents} docs`,
        )
        await db.agentRun.update({
          where: { id: run.id },
          data: {
            status: 'succeeded',
            finishedAt: new Date(),
            meta: { ...(run.meta as Prisma.InputJsonObject), result: asJson(result) },
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
    }
  }
}
