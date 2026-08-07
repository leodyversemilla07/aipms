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
import { PolicyService } from './policy.service'

const policyKind = z.enum([
  'threshold',
  'preferredVendor',
  'approvalChain',
  'budgetControl',
  'evaluationCriterion',
])

const idInput = z.object({ id: z.string().min(1) })

const createPolicyInput = z.object({
  idempotencyKey: z.string().min(1),
  name: z.string().min(1).max(200),
  kind: policyKind,
  enabled: z.boolean().default(true),
  supersedesId: z.string().min(1).nullish(),
  config: z.record(z.string(), z.unknown()),
})

const listPolicyInput = z.object({
  kind: policyKind.optional(),
  enabled: z.boolean().optional(),
})

@Router({ alias: 'policy' })
@UseMiddlewares(AuthMiddleware)
export class PolicyRouter {
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listPolicyInput>) {
    return this.policy.list(input)
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.policy.detail(input.id)
  }

  @Query()
  async activeByKind() {
    return this.policy.activeByKind()
  }

  @Mutation()
  async create(
    @Input() input: z.infer<typeof createPolicyInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const { idempotencyKey: _key, ...rest } = input
      const policy = await this.policy.create({
        ...rest,
        updatedBy: ctx.user.id,
      })
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'policy.create',
        entity: 'Policy',
        entityId: policy.id,
        input: rest,
        after: policy,
      })
      return policy
    })
  }
}
