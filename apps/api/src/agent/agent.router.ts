import { Inject } from '@nestjs/common'
import { Ctx, Input, Mutation, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { AgentService } from './agent.service'

const processInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
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
        actorKind: 'human',
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
}
