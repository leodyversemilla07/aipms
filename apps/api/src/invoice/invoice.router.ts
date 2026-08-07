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
import { InvoiceService } from './invoice.service'

const lineInput = z.object({
  description: z.string().optional(),
  amountMinor: z.number().int().nonnegative(),
  class: z.enum(['goods', 'services', 'professional', 'rental', 'other']),
  vatExempt: z.boolean().optional(),
})

const computeInput = z.object({ lines: z.array(lineInput).min(1) })

const registerInput = z.object({
  idempotencyKey: z.string().min(1),
  vendorId: z.string().min(1),
  number: z.string().min(1).max(80),
  poId: z.string().min(1).optional(),
  currencyCode: z.string().length(3).default('PHP'),
  lines: z.array(lineInput).min(1),
  receivedAt: z.coerce.date().optional(),
})

const idInput = z.object({ id: z.string().min(1) })

const listInputWithStatus = listInput.extend({
  status: z.enum(['received', 'matched', 'exception', 'paid']).optional(),
})

@Router({ alias: 'invoice' })
@UseMiddlewares(AuthMiddleware)
export class InvoiceRouter {
  constructor(
    @Inject(InvoiceService) private readonly invoice: InvoiceService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listInputWithStatus>) {
    return this.invoice.list(input.status ? { status: input.status } : {})
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.invoice.detail(input.id)
  }

  /** §8.4 deterministic tax foot: the agent calls this to *explain* net amounts. */
  @Query()
  async compute(@Input() input: z.infer<typeof computeInput>) {
    return this.invoice.compute(input)
  }

  @Mutation()
  async register(
    @Input() input: z.infer<typeof registerInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const result = await this.invoice.register(input)
      const id = (result.invoice as { id?: string }).id
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'invoice.register',
        entity: 'Invoice',
        entityId: id,
        input,
        after: result.invoice as object,
      })
      return {
        ...result,
        taxPolicyVersion: (
          result.invoice as { taxPolicyVersion?: string | null }
        ).taxPolicyVersion,
      }
    })
  }
}
