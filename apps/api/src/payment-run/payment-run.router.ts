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
import { PaymentRunService } from './payment-run.service'

const createInput = z.object({
  idempotencyKey: z.string().min(1),
  invoiceIds: z.array(z.string().min(1)).min(1),
  notes: z.unknown().optional(),
})

const runIdInput = z.object({ id: z.string().min(1) })

const reconcileInput = z.object({
  runId: z.string().min(1),
  lineId: z.string().min(1),
  status: z.enum(['paid', 'dishonored', 'rejected']),
})

const listInputWithStatus = listInput.extend({
  status: z
    .enum(['draft', 'approved', 'executed', 'reconciled', 'voided'])
    .optional(),
})

@Router({ alias: 'paymentRun' })
@UseMiddlewares(AuthMiddleware)
export class PaymentRunRouter {
  constructor(
    @Inject(PaymentRunService) private readonly runs: PaymentRunService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listInputWithStatus>) {
    return this.runs.list(input.status ? { status: input.status } : {})
  }

  @Query()
  async detail(@Input() input: z.infer<typeof runIdInput>) {
    return this.runs.detail(input.id)
  }

  @Mutation()
  async create(
    @Input() input: z.infer<typeof createInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.runs.create(input, ctx.user.id)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'paymentRun.create',
        entity: 'PaymentRun',
        entityId: result.run.id,
        input,
        after: result.run as object,
      })
      return result
    })
  }

  @Mutation()
  async approve(
    @Input() input: z.infer<typeof runIdInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const run = await this.runs.approve(input.id, ctx.user.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'paymentRun.approve',
      entity: 'PaymentRun',
      entityId: run.id,
      input,
      after: run as object,
    })
    return run
  }

  @Mutation()
  async execute(
    @Input() input: z.infer<typeof runIdInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const run = await this.runs.execute(input.id, ctx.user.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'paymentRun.execute',
      entity: 'PaymentRun',
      entityId: run.id,
      input,
      after: run as object,
    })
    return run
  }

  @Mutation()
  async reconcile(
    @Input() input: z.infer<typeof reconcileInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const result = await this.runs.reconcile(
      input.runId,
      input.lineId,
      input.status,
    )
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'paymentRun.reconcile',
      entity: 'PaymentRunLine',
      entityId: input.lineId,
      input,
      after: result as object,
    })
    return result
  }

  @Mutation()
  async voidRun(
    @Input() input: z.infer<typeof runIdInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const run = await this.runs.voidRun(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'paymentRun.void',
      entity: 'PaymentRun',
      entityId: run.id,
      input,
      after: run as object,
    })
    return run
  }
}
