import { ConflictException, Inject, NotFoundException } from '@nestjs/common'
import { db } from '@workspace/db'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput, paginate } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { AgentService } from './agent.service'
import { AgentCommandService } from './agent-command.service'

const processInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
})

const batchInput = z.object({
  limit: z.number().int().min(1).max(100).default(10),
})

const runsInput = listInput.extend({
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']).optional(),
})

const cancelStaleRunInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
})

function staleRunCutoff() {
  const configured = Number(process.env.AUTOMATION_LEASE_TIMEOUT_MS ?? 900_000)
  const timeoutMs =
    Number.isFinite(configured) && configured >= 1000 ? configured : 900_000
  return new Date(Date.now() - timeoutMs)
}

function commandActor(ctx: AuthedTrpcContext, idempotencyKey?: string) {
  const rawScopes = (ctx.user as { scopes?: unknown }).scopes
  return {
    id: ctx.user.id,
    kind: ctx.actorKind,
    role: ctx.user.role,
    scopes: Array.isArray(rawScopes)
      ? rawScopes.filter((scope): scope is string => typeof scope === 'string')
      : undefined,
    idempotencyKey,
    source: 'trpc' as const,
  }
}

/**
 * §3 agent surface — promote a raw intake document to a registered invoice.
 * The extraction algorithm is swappable (structured default, LLM later); the
 * pipeline (classify → register) is fixed and audited.
 */
@Router({ alias: 'agent' })
@UseMiddlewares(AuthMiddleware)
export class AgentRouter {
  constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(AgentCommandService)
    private readonly commands: AgentCommandService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Mutation({ input: processInput })
  async process(
    @Input() input: z.infer<typeof processInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'agent.process',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        return this.commands.processDocument(
          input.id,
          commandActor(ctx, input.idempotencyKey),
          tx,
        )
      },
    )
  }

  /**
   * Drain the queue: process up to `limit` pending documents. Per-doc
   * failures are reported, not fatal; the worker loop (or eve) calls this.
   */
  @Mutation({ input: batchInput })
  async batch(
    @Input() input: z.infer<typeof batchInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    // The shared command boundary authorizes once, commits and audits each
    // document independently, then appends the batch summary. Retries only
    // pick up documents that remain new.
    return this.commands.processPending(input.limit, commandActor(ctx))
  }

  /** §7.1 — run history for the supervisory desk. */
  @Query({ input: runsInput })
  async runs(@Input() input: z.infer<typeof runsInput>) {
    return this.agent.listRuns(input)
  }

  @Query({ input: listInput })
  async staleRuns(@Input() input: z.infer<typeof listInput>) {
    const { skip, take } = paginate(input)
    const q = input.q.trim()
    const where = {
      status: 'running' as const,
      startedAt: { lt: staleRunCutoff() },
      ...(q
        ? {
            OR: [
              { id: { contains: q, mode: 'insensitive' as const } },
              { agentId: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      db.agentRun.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          agentId: true,
          skills: true,
          startedAt: true,
          status: true,
        },
      }),
      db.agentRun.count({ where }),
    ])
    return { rows, total, facetCounts: {} }
  }

  @Mutation({ input: cancelStaleRunInput })
  async cancelStaleRun(
    @Input() input: z.infer<typeof cancelStaleRunInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'agent.cancelStaleRun',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "agentRun" WHERE id = ${input.id} FOR UPDATE
        `
        const run = await tx.agentRun.findUnique({ where: { id: input.id } })
        if (!run) throw new NotFoundException(`Agent run ${input.id} not found`)
        if (run.status !== 'running' || run.startedAt >= staleRunCutoff()) {
          throw new ConflictException(
            'Agent run is not stale and running; reload before recovery',
          )
        }
        const finishedAt = new Date()
        const changed = await tx.agentRun.updateMany({
          where: {
            id: run.id,
            status: 'running',
            startedAt: { lt: staleRunCutoff() },
          },
          data: { status: 'cancelled', finishedAt },
        })
        if (changed.count !== 1) {
          throw new ConflictException(
            'Agent run changed; reload before recovery',
          )
        }
        const updated = await tx.agentRun.findUniqueOrThrow({
          where: { id: run.id },
        })
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'agent.stale.cancel',
            entity: 'AgentRun',
            entityId: run.id,
            input: { reason: input.reason },
            before: run as object,
            after: { ...updated, recoveryReason: input.reason },
          },
          tx,
        )
        return updated
      },
    )
  }
}
