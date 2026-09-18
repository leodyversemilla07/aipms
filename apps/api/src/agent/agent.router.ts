import { Inject } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { AgentCommandService } from './agent-command.service'
import { AgentService } from './agent.service'

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
          this.commandActor(ctx, input.idempotencyKey),
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
    return this.commands.processPending(input.limit, this.commandActor(ctx))
  }

  /** §7.1 — run history for the supervisory desk. */
  @Query({ input: runsInput })
  async runs(@Input() input: z.infer<typeof runsInput>) {
    return this.agent.listRuns(input)
  }

  private commandActor(
    ctx: AuthedTrpcContext,
    idempotencyKey?: string,
  ) {
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
}
