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
import { RequisitionService } from './requisition.service'

const lineInput = z.object({
  sku: z.string().min(1).max(100).nullish(),
  description: z.string().min(1).max(500),
  quantity: z.number().int().positive(),
  unit: z.string().max(20).optional(),
  unitPriceMinor: z.number().int().nonnegative(),
  currencyCode: z.string().length(3).optional(),
})

const createRequisitionInput = z.object({
  idempotencyKey: z.string().min(1),
  costCenter: z.string().min(1).max(80),
  budgetId: z.string().min(1).nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  note: z.string().max(1000).nullish(),
  lines: z.array(lineInput).min(1).max(200),
})

const idInput = z.object({ id: z.string().min(1) })

const submitInput = idInput.extend({ idempotencyKey: z.string().min(1) })

@Router({ alias: 'requisition' })
@UseMiddlewares(AuthMiddleware)
export class RequisitionRouter {
  constructor(
    @Inject(RequisitionService)
    private readonly requisition: RequisitionService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.requisition.list(input)
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.requisition.detail(input.id)
  }

  @Query()
  async exceptionQueue() {
    return this.requisition.exceptionQueue()
  }

  @Mutation()
  async create(
    @Input() input: z.infer<typeof createRequisitionInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const requisition = await this.requisition.create({
        requestedBy: ctx.user.id,
        costCenter: input.costCenter,
        budgetId: input.budgetId,
        priority: input.priority,
        note: input.note,
        lines: input.lines,
      })
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'requisition.create',
        entity: 'Requisition',
        entityId: requisition.id,
        input,
        after: requisition,
      })
      return requisition
    })
  }

  @Mutation()
  async submit(
    @Input() input: z.infer<typeof submitInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.requisition.submit(input.id)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'requisition.submit',
        entity: 'Requisition',
        entityId: input.id,
        input: { id: input.id, outcome: result.decision.outcome },
        after: result.requisition,
      })
      return result
    })
  }
}
