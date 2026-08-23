import { Inject } from '@nestjs/common'
import { Ctx, Input, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { BirService } from './bir.service'

const periodInput = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

const certificateInput = periodInput.extend({ vendorId: z.string().min(1) })

/**
 * §8.4 statutory report surface. Read-only: BIR Form 2307 certificates and
 * the 1601-E monthly remittance summary are derived deterministically from
 * stored invoices on every call — no mutable state, nothing to approve.
 */
@Router({ alias: 'bir' })
@UseMiddlewares(AuthMiddleware)
export class BirRouter {
  constructor(@Inject(BirService) private readonly bir: BirService) {}

  /** BIR Form 2307 — Certificate of Creditable Tax Withheld at Source. */
  @Query({ input: certificateInput })
  async certificate(
    @Input() input: z.infer<typeof certificateInput>,
    @Ctx() _ctx: AuthedTrpcContext,
  ) {
    return this.bir.form2307(input)
  }

  /** BIR Form 1601-E — monthly remittance summary per supplier. */
  @Query({ input: periodInput })
  async remittance(
    @Input() input: z.infer<typeof periodInput>,
    @Ctx() _ctx: AuthedTrpcContext,
  ) {
    return this.bir.summary1601e(input)
  }

  /** Periods that carry withholding data (drives UI period pickers). */
  @Query({ input: z.object({}) })
  async periods(@Input() _input: Record<string, never>) {
    return this.bir.list({})
  }
}
