import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common'
import { db, type Prisma, type UserKind, type UserRole } from '@workspace/db'
import {
  type IssueInput,
  PurchaseOrderService,
} from '../purchase-order/purchase-order.service'
import {
  AgentQuotaExceededError,
  AgentQuotaService,
} from '../shared/agent-quota/agent-quota.service'
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
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
  private readonly db: typeof db

  constructor(
    private readonly agent: AgentService,
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly audit: AuditService,
    private readonly quotas: AgentQuotaService,
    @Optional()
    private readonly idempotency?: IdempotencyService,
    @Optional()
    dbClient?: typeof db,
  ) {
    this.db = dbClient ?? db
  }

  async processDocument(
    docId: string,
    actor: CommandActor,
    outerTx?: Prisma.TransactionClient,
  ) {
    await this.authorize(actor, 'agent.process', 'intake.registerInvoice')
    return this.quotas.run(actor, 'agent.process', () =>
      this.processAuthorizedDocument(docId, actor, outerTx),
    )
  }

  private async processAuthorizedDocument(
    docId: string,
    actor: CommandActor,
    outerTx?: Prisma.TransactionClient,
  ) {
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
    return this.quotas.run(actor, 'agent.batch', () =>
      this.processAuthorizedPending(limit, actor),
    )
  }

  private async processAuthorizedPending(limit: number, actor: CommandActor) {
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
      let deferred = 0
      let quotaLimited = false
      const failed: Array<{ docId: string; error: string }> = []
      for (const doc of docs) {
        try {
          await this.processDocument(doc.id, effectiveActor)
          succeeded += 1
        } catch (error) {
          if (error instanceof AgentQuotaExceededError) {
            deferred = docs.length - succeeded - failed.length
            quotaLimited = true
            break
          }
          failed.push({ docId: doc.id, error: this.errorMessage(error) })
        }
      }
      const result = {
        documents: docs.length,
        succeeded,
        failed,
        deferred,
        quotaLimited,
      }
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
            status:
              failed.length === 0 && !quotaLimited ? 'succeeded' : 'failed',
            finishedAt: new Date(),
            meta: {
              source: actor.source,
              limit,
              idempotencyKey: actor.idempotencyKey,
              documents: docs.length,
              succeeded,
              failed: failed.length,
              deferred,
              quotaLimited,
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

  /**
   * §7.1 — close an agent run.
   *
   * The eve runtime cannot finish its own trace from the outside, so the
   * agent calls this with the outcome of the work it was woken for. The run
   * id is the eve session id carried by the scoped bearer, so the agent
   * cannot close a run it does not own.
   */
  async completeRun(
    input: { outcome?: string; summary?: string; runId?: string },
    actor: CommandActor,
  ) {
    const outcome =
      input.outcome === 'succeeded'
        ? 'succeeded'
        : input.outcome === 'failed'
          ? 'failed'
          : null
    if (!outcome) {
      throw new BadRequestException('outcome must be "succeeded" or "failed"')
    }
    const runId = (input.runId ?? actor.runId ?? '').trim()
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(runId)) {
      throw new BadRequestException('runId contains invalid characters')
    }
    const run = await this.db.agentRun.findUnique({ where: { id: runId } })
    if (!run) {
      throw new NotFoundException(`Agent run ${runId} not found`)
    }
    if (run.agentId !== actor.id) {
      throw new ForbiddenException('Agent run belongs to another principal')
    }
    if (run.finishedAt) {
      // Completion is idempotent: a retried call must not reopen the run.
      return run
    }
    const summary = input.summary?.trim().slice(0, 2000)
    const updated = await this.db.agentRun.update({
      where: { id: run.id },
      data: {
        status: outcome,
        finishedAt: new Date(),
        meta: {
          ...((run.meta ?? {}) as Prisma.InputJsonObject),
          completion: {
            outcome,
            summary: summary ?? null,
            source: actor.source,
            completedAt: new Date().toISOString(),
          },
        },
      },
    })
    await this.audit.record({
      runId: run.id,
      actorId: actor.id,
      actorKind: actor.kind,
      action: 'agent.run.complete',
      entity: 'AgentRun',
      entityId: run.id,
      input: { outcome, source: actor.source },
      after: { status: updated.status, summary: summary ?? null },
    })
    return updated
  }

  async issuePurchaseOrder(input: IssueInput, actor: CommandActor) {
    await this.authorize(actor, 'purchaseOrder.issue', 'purchaseOrder.issue')
    return this.quotas.run(actor, 'purchaseOrder.issue', () =>
      this.issueAuthorizedPurchaseOrder(input, actor),
    )
  }

  private async issueAuthorizedPurchaseOrder(
    input: IssueInput,
    actor: CommandActor,
  ) {
    const execute = async (tx: Prisma.TransactionClient) => {
      const result = await this.purchaseOrders.issue(input, actor.id, tx)
      await this.audit.record(
        {
          runId: actor.runId,
          actorId: actor.id,
          actorKind: actor.kind,
          action:
            result.outcome === 'ISSUED'
              ? 'purchaseOrder.issue'
              : 'purchaseOrder.vendorGate',
          entity: 'PurchaseOrder',
          entityId:
            result.outcome === 'ISSUED'
              ? result.purchaseOrder.id
              : input.requisitionId,
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
    }

    try {
      if (actor.idempotencyKey && this.idempotency) {
        return await this.idempotency.runAtomic(
          {
            actorId: actor.id,
            operation: 'purchaseOrder.issue',
            key: actor.idempotencyKey,
            input,
          },
          execute,
        )
      }
      return await this.db.$transaction(execute)
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
