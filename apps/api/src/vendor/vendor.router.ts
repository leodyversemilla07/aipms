import { Inject, NotFoundException } from '@nestjs/common'
import { db } from '@workspace/db'
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
import { requireRole } from '../trpc/authorize'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { VendorService } from './vendor.service'

const idInput = z.object({ id: z.string().min(1) })

const vendorStatus = z.enum(['prospective', 'active', 'watch', 'blacklisted'])

const verifyBankAccountInput = z.object({
  id: z.string().min(1),
  bankAccount: z.any(),
})

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

  @Query({ input: listInput })
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.vendor.list(input)
  }

  @Query({ input: idInput })
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.vendor.detail(input.id)
  }

  @Mutation({ input: createVendorInput })
  async create(
    @Input() input: z.infer<typeof createVendorInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'vendor.create',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const vendor = await this.vendor.create(input, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'vendor.create',
            entity: 'Vendor',
            entityId: vendor.id,
            input,
            after: vendor,
          },
          tx,
        )
        return vendor
      },
    )
  }

  @Mutation({ input: updateVendorInput })
  async update(
    @Input() input: z.infer<typeof updateVendorInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'vendor.update',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const { id, idempotencyKey: _key, ...rest } = input
        const before = await tx.vendor.findUnique({ where: { id } })
        if (!before) throw new NotFoundException(`Vendor ${id} not found`)
        const vendor = await this.vendor.update(id, rest, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'vendor.update',
            entity: 'Vendor',
            entityId: id,
            input: { id, ...rest },
            before,
            after: vendor,
          },
          tx,
        )
        return vendor
      },
    )
  }

  /** §8.6: record + verify a vendor's beneficiary bank account. */
  @Mutation({ input: verifyBankAccountInput })
  async verifyBankAccount(
    @Input() input: z.infer<typeof verifyBankAccountInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(
      ctx.user,
      ctx.actorKind,
      ['finance'],
      'vendor.verifyBankAccount',
    )
    return db.$transaction(async (tx) => {
      const vendor = await this.vendor.verifyBankAccount(
        input.id,
        input.bankAccount,
        tx,
      )
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorKind: ctx.actorKind,
          action: 'vendor.verifyBankAccount',
          entity: 'Vendor',
          entityId: vendor.id,
          input,
          after: vendor,
        },
        tx,
      )
      return vendor
    })
  }
}
