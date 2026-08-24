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
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
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
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Mutation({ input: processInput })
  async process(
    @Input() input: z.infer<typeof processInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.agent.classifyAndRegister(input.id)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'agent.process',
        entity: 'IntakeDocument',
        entityId: input.id,
        input,
        after: {
          docStatus: result.doc.status,
          invoiceId: (result.invoice as { id?: string }).id,
          matchOutcome: result.match?.outcome,
        },
      })
      return result
    })
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
    const result = await this.agent.processPending(input.limit)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'agent.batch',
      entity: 'IntakeDocument',
      entityId: null,
      input,
      after: result,
    })
    return result
  }

  /** §7.1 — run history for the supervisory desk. */
  @Query({ input: runsInput })
  async runs(@Input() input: z.infer<typeof runsInput>) {
    return this.agent.listRuns(input)
  }
}
