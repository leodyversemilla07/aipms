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
import { ReceiptService } from './receipt.service'

// Exported so nestjs-trpc's generator can import it into the generated
// router surface (a local const is emitted as a dangling reference).
export const receiptLineInput = z.object({
  poLineId: z.string().min(1).optional(),
  lineNo: z.number().int().min(1).optional(),
  sku: z.string().min(1).max(60).optional(),
  description: z.string().min(1).max(300),
  quantity: z.number().int().min(1),
  unit: z.string().min(1).max(20).optional(),
})

const recordInput = z.object({
  idempotencyKey: z.string().min(1),
  poId: z.string().min(1),
  lines: z.array(receiptLineInput).min(1),
  note: z.string().max(500).optional(),
  /** §7.1 agent execution tag when recorded by an agent. */
  runId: z.string().min(1).optional(),
})

const listInputWithFilters = listInput.extend({
  status: z.enum(['recorded', 'cancelled']).optional(),
  poId: z.string().min(1).optional(),
})

const idInput = z.object({ id: z.string().min(1) })

@Router({ alias: 'receipt' })
@UseMiddlewares(AuthMiddleware)
export class ReceiptRouter {
  constructor(
    @Inject(ReceiptService) private readonly receipts: ReceiptService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInputWithFilters })
  async list(@Input() input: z.infer<typeof listInputWithFilters>) {
    return this.receipts.list(input)
  }

  @Query({ input: idInput })
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.receipts.detail(input.id)
  }

  @Mutation({ input: recordInput })
  async record(
    @Input() input: z.infer<typeof recordInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'receipt.record',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const { receipt, rematch } = await this.receipts.record(
          {
            poId: input.poId,
            lines: input.lines,
            note: input.note ?? null,
            recordedBy: ctx.user.id,
          },
          tx,
        )
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'receipt.record',
            entity: 'Receipt',
            entityId: (receipt as { id: string }).id,
            input: { poId: input.poId, lines: input.lines },
            after: { rematch },
          },
          tx,
        )
        return { receipt, rematch }
      },
    )
  }

  @Mutation({ input: idInput })
  async cancel(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const receipt = await this.receipts.cancel(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'receipt.cancel',
      entity: 'Receipt',
      entityId: input.id,
    })
    return receipt
  }
}
