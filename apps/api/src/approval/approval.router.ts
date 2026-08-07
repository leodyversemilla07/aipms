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
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { ApprovalService } from './approval.service'

const idInput = z.object({ id: z.string().min(1) })

const decideInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  verdict: z.enum(['approve', 'reject', 'override']),
  evidence: z.string().max(1000).optional(),
})

@Router({ alias: 'approval' })
@UseMiddlewares(AuthMiddleware)
export class ApprovalRouter {
  constructor(
    @Inject(ApprovalService) private readonly approval: ApprovalService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async pendingList() {
    return this.approval.pendingList()
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.approval.detail(input.id)
  }

  @Mutation()
  async decide(
    @Input() input: z.infer<typeof decideInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.approval.decide(
        input.id,
        input.verdict,
        ctx.user.id,
        input.evidence,
      )
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'approval.decide',
        entity: 'Approval',
        entityId: input.id,
        input: {
          id: input.id,
          verdict: input.verdict,
          evidence: input.evidence,
        },
        after: result,
      })
      return result
    })
  }
}
