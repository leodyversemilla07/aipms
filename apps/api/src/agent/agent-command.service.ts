import { BadRequestException, Injectable } from '@nestjs/common'
import { db, type Prisma, type UserKind, type UserRole } from '@workspace/db'
import {
  type IssueInput,
  PurchaseOrderService,
} from '../purchase-order/purchase-order.service'
import { AuditService } from '../shared/audit/audit.service'
import {
  assertAgentCapability,
  resolveAgentScopes,
} from '../trpc/agent-capabilities'
import { assertHumanProcedureRole } from '../trpc/authorize'
import { AgentService } from './agent.service'

export interface CommandActor {
  id: string
  kind: UserKind
  role?: UserRole
  scopes?: readonly string[]
  runId?: string
  idempotencyKey?: string
  source: 'trpc' | 'service-api' | 'scheduler' | 'event-wake'
}

/**
 * Authorized and audited command boundary shared by every agent entry point.
 * Schedulers, event wakes, REST service calls, and tRPC can no longer invoke
 * state-changing domain services without the same capability and audit rules.
 */
@Injectable()
export class AgentCommandService {
  constructor(
    private readonly agent: AgentService,
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly audit: AuditService,
  ) {}

  async processDocument(
    docId: string,
    actor: CommandActor,
    outerTx?: Prisma.TransactionClient,
  ) {
    await this.authorize(actor, 'agent.process', 'intake.registerInvoice')
    const run = async (tx: Prisma.TransactionClient) => {
      const result = await this.agent.classifyAndRegister(docId, tx)
      await this.audit.record(
        {
          runId: actor.runId,
          actorId: actor.id,
          actorKind: actor.kind,
          action: 'agent.process',
          entity: 'IntakeDocument',
          entityId: docId,
          input: {
            docId,
            source: actor.source,
            idempotencyKey: actor.idempotencyKey,
          },
          after: {
            docStatus: result.doc.status,
            invoiceId: (result.invoice as { id?: string }).id,
            matchOutcome: result.match?.outcome,
          },
        },
        tx,
      )
      return result
    }
    if (outerTx) return run(outerTx)
    try {
      return await db.$transaction(run)
    } catch (error) {
      await this.recordFailure(
        'agent.process',
        'IntakeDocument',
        docId,
        actor,
        {
          docId,
        },
        error,
      )
      throw error
    }
  }

  async processPending(limit: number, actor: CommandActor) {
    await this.authorize(actor, 'agent.batch', 'intake.registerInvoice')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      const error = new BadRequestException(
        'Agent batch limit must be from 1 to 100',
      )
      await this.recordFailure(
        'agent.batch',
        'IntakeDocument',
        null,
        actor,
        { limit },
        error,
      )
      throw error
    }
    const ownedRun = actor.runId
      ? null
      : await db.agentRun.create({
          data: {
            agentId: actor.id,
            skills: ['intake-classify'],
            meta: {
              source: actor.source,
              limit,
              idempotencyKey: actor.idempotencyKey,
            },
          },
        })
    const effectiveActor = ownedRun ? { ...actor, runId: ownedRun.id } : actor
    try {
      const docs = await db.intakeDocument.findMany({
        where: { status: 'new' },
        orderBy: { receivedAt: 'asc' },
        take: limit,
        select: { id: true },
      })
      let succeeded = 0
      const failed: Array<{ docId: string; error: string }> = []
      for (const doc of docs) {
        try {
          await this.processDocument(doc.id, effectiveActor)
          succeeded += 1
        } catch (error) {
          failed.push({ docId: doc.id, error: this.errorMessage(error) })
        }
      }
      const result = { documents: docs.length, succeeded, failed }
      await this.audit.record({
        runId: effectiveActor.runId,
        actorId: effectiveActor.id,
        actorKind: effectiveActor.kind,
        action: 'agent.batch',
        entity: 'IntakeDocument',
        entityId: null,
        input: {
          limit,
          source: effectiveActor.source,
          idempotencyKey: effectiveActor.idempotencyKey,
        },
        after: result,
      })
      if (ownedRun) {
        await db.agentRun.update({
          where: { id: ownedRun.id },
          data: {
            status: failed.length === 0 ? 'succeeded' : 'failed',
            finishedAt: new Date(),
            meta: {
              source: actor.source,
              limit,
              idempotencyKey: actor.idempotencyKey,
              documents: docs.length,
              succeeded,
              failed: failed.length,
            },
          },
        })
      }
      return result
    } catch (error) {
      await this.recordFailure(
        'agent.batch',
        'IntakeDocument',
        null,
        effectiveActor,
        { limit },
        error,
      )
      if (ownedRun) {
        await db.agentRun.update({
          where: { id: ownedRun.id },
          data: {
            status: 'failed',
            finishedAt: new Date(),
            meta: {
              source: actor.source,
              limit,
              idempotencyKey: actor.idempotencyKey,
              error: this.errorMessage(error),
            },
          },
        })
      }
      throw error
    }
  }

  async issuePurchaseOrder(input: IssueInput, actor: CommandActor) {
    await this.authorize(actor, 'purchaseOrder.issue', 'purchaseOrder.issue')
    try {
      return await db.$transaction(async (tx) => {
        const result = await this.purchaseOrders.issue(input, actor.id, tx)
        await this.audit.record(
          {
            runId: actor.runId,
            actorId: actor.id,
            actorKind: actor.kind,
            action: 'purchaseOrder.issue',
            entity: 'Requisition',
            entityId: input.requisitionId,
            input: {
              ...input,
              source: actor.source,
              idempotencyKey: actor.idempotencyKey,
            },
            after:
              result.outcome === 'ISSUED'
                ? {
                    outcome: result.outcome,
                    purchaseOrderId: result.purchaseOrder.id,
                    poNumber: result.purchaseOrder.poNumber,
                  }
                : result,
          },
          tx,
        )
        return result
      })
    } catch (error) {
      await this.recordFailure(
        'purchaseOrder.issue',
        'Requisition',
        input.requisitionId,
        actor,
        input,
        error,
      )
      throw error
    }
  }

  private async authorize(
    actor: CommandActor,
    humanPath: string,
    agentPath: string,
  ) {
    try {
      if (actor.kind === 'agent') {
        assertAgentCapability(
          agentPath,
          actor.scopes ?? resolveAgentScopes(process.env),
        )
        return
      }
      assertHumanProcedureRole(humanPath, actor.role ?? 'user')
    } catch (error) {
      await this.audit.record({
        runId: actor.runId,
        actorId: actor.id,
        actorKind: actor.kind,
        action: `${humanPath}.denied`,
        entity: 'Authorization',
        entityId: humanPath,
        input: {
          humanPath,
          agentPath,
          source: actor.source,
          idempotencyKey: actor.idempotencyKey,
        },
        after: { error: this.errorMessage(error) },
      })
      throw error
    }
  }

  private async recordFailure(
    action: string,
    entity: string,
    entityId: string | null,
    actor: CommandActor,
    input: object,
    error: unknown,
  ) {
    await this.audit.record({
      runId: actor.runId,
      actorId: actor.id,
      actorKind: actor.kind,
      action: `${action}.failed`,
      entity,
      entityId,
      input: {
        ...input,
        source: actor.source,
        idempotencyKey: actor.idempotencyKey,
      },
      after: { error: this.errorMessage(error) },
    })
  }

  private errorMessage(error: unknown) {
    return error instanceof Error
      ? error.message.slice(0, 500)
      : 'Unknown error'
  }
}
