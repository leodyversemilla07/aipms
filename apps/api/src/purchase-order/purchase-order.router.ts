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
import { PurchaseOrderService } from './purchase-order.service'

const idInput = z.object({ id: z.string().min(1) })

const issueInput = z.object({
  idempotencyKey: z.string().min(1),
  requisitionId: z.string().min(1),
  vendorId: z.string().min(1),
  terms: z.record(z.string(), z.unknown()).optional(),
})

const confirmInput = idInput.extend({ idempotencyKey: z.string().min(1) })

const cancellationInput = idInput.extend({
  idempotencyKey: z.string().min(1),
  reason: z.string().min(1).max(500),
})

@Router({ alias: 'purchaseOrder' })
@UseMiddlewares(AuthMiddleware)
export class PurchaseOrderRouter {
  constructor(
    @Inject(PurchaseOrderService)
    private readonly purchaseOrder: PurchaseOrderService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.purchaseOrder.list(input)
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.purchaseOrder.detail(input.id)
  }

  @Mutation()
  async issue(
    @Input() input: z.infer<typeof issueInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.purchaseOrder.issue(input, ctx.user.id)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action:
          result.outcome === 'ISSUED'
            ? 'purchaseOrder.issue'
            : 'purchaseOrder.vendorGate',
        entity: 'PurchaseOrder',
        entityId:
          result.outcome === 'ISSUED'
            ? result.purchaseOrder.id
            : input.requisitionId,
        input,
        after: result,
      })
      return result
    })
  }

  @Mutation()
  async confirm(
    @Input() input: z.infer<typeof confirmInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const po = await this.purchaseOrder.confirm(input.id)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'purchaseOrder.confirm',
        entity: 'PurchaseOrder',
        entityId: po.id,
        after: po,
      })
      return po
    })
  }

  @Mutation()
  async requestCancellation(
    @Input() input: z.infer<typeof cancellationInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const approval = await this.purchaseOrder.requestCancellation(
        input.id,
        input.reason,
      )
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'purchaseOrder.cancelRequest',
        entity: 'PurchaseOrder',
        entityId: input.id,
        input: { id: input.id, reason: input.reason },
        after: approval,
      })
      return approval
    })
  }
}
