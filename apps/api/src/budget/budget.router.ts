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
import { BudgetService } from './budget.service'

const createBudgetInput = z.object({
  idempotencyKey: z.string().min(1),
  name: z.string().min(1).max(200),
  costCenter: z.string().min(1).max(80),
  period: z.string().min(1).max(20),
  currencyCode: z.string().length(3).default('PHP'),
  limitMinor: z.number().int().nonnegative(),
})

const detailInput = z.object({
  id: z.string().min(1),
  includeRemaining: z.boolean().optional(),
})

@Router({ alias: 'budget' })
@UseMiddlewares(AuthMiddleware)
export class BudgetRouter {
  constructor(
    @Inject(BudgetService) private readonly budget: BudgetService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInput })
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.budget.list(input)
  }

  @Query({ input: detailInput })
  async detail(@Input() input: z.infer<typeof detailInput>) {
    if (input.includeRemaining) return this.budget.remaining(input.id)
    return this.budget.detail(input.id)
  }

  @Mutation({ input: createBudgetInput })
  async create(
    @Input() input: z.infer<typeof createBudgetInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const budget = await this.budget.create(input)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'budget.create',
        entity: 'Budget',
        entityId: budget.id,
        input,
        after: budget,
      })
      return budget
    })
  }
}
