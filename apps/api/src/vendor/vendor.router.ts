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
import { VendorService } from './vendor.service'

const idInput = z.object({ id: z.string().min(1) })

const vendorStatus = z.enum(['prospective', 'active', 'watch', 'blacklisted'])

const createVendorInput = z.object({
  idempotencyKey: z.string().min(1),
  name: z.string().min(1).max(200),
  email: z.string().email().nullish(),
  taxId: z.string().max(30).nullish(),
  paymentTermsDays: z.number().int().positive().nullish(),
  ratingScore: z.number().int().min(0).max(100).nullish(),
  status: vendorStatus.optional(),
})

const updateVendorInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullish(),
  taxId: z.string().max(30).nullish(),
  paymentTermsDays: z.number().int().positive().nullish(),
  ratingScore: z.number().int().min(0).max(100).nullish(),
  status: vendorStatus.optional(),
  blacklistReason: z.string().max(500).nullish(),
})

@Router({ alias: 'vendor' })
@UseMiddlewares(AuthMiddleware)
export class VendorRouter {
  constructor(
    @Inject(VendorService) private readonly vendor: VendorService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query()
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.vendor.list(input)
  }

  @Query()
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.vendor.detail(input.id)
  }

  @Mutation()
  async create(
    @Input() input: z.infer<typeof createVendorInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const vendor = await this.vendor.create(input)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'vendor.create',
        entity: 'Vendor',
        entityId: vendor.id,
        input,
        after: vendor,
      })
      return vendor
    })
  }

  @Mutation()
  async update(
    @Input() input: z.infer<typeof updateVendorInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const { id, idempotencyKey: _key, ...rest } = input
      const before = await this.vendor.detail(id)
      const vendor = await this.vendor.update(id, rest)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'vendor.update',
        entity: 'Vendor',
        entityId: id,
        input: { id, ...rest },
        before,
        after: vendor,
      })
      return vendor
    })
  }

  /** §8.6: record + verify a vendor's beneficiary bank account. */
  @Mutation()
  async verifyBankAccount(
    @Input() input: z.infer<typeof idInput> & { bankAccount: unknown },
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const vendor = await this.vendor.verifyBankAccount(
      input.id,
      input.bankAccount,
    )
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'vendor.verifyBankAccount',
      entity: 'Vendor',
      entityId: vendor.id,
      input,
      after: vendor,
    })
    return vendor
  }
}
