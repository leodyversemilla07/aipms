import { Inject } from '@nestjs/common'
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
import { requireRole } from '../trpc/authorize'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { SourcingService } from './sourcing.service'

const requestInput = z.object({
  requisitionId: z.string().min(1),
  vendorIds: z.array(z.string().min(1)).min(1),
})

const quoteIdInput = z.object({ id: z.string().min(1) })

const receiveInput = z.object({
  id: z.string().min(1),
  totalMinor: z.number().int().positive(),
  currencyCode: z.string().min(3).max(3).optional(),
  leadTimeDays: z.number().int().positive().optional(),
  validUntil: z.date().optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().optional(),
        description: z.string(),
        quantity: z.number().int().positive().optional(),
        unitPriceMinor: z.number().int().nonnegative().optional(),
        amountMinor: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  payload: z.unknown().optional(),
})

const compareInput = z.object({ requisitionId: z.string().min(1) })

const listInput = z.object({
  requisitionId: z.string().min(1).optional(),
  status: z.enum(['requested', 'received', 'accepted', 'rejected']).optional(),
})

@Router({ alias: 'sourcing' })
@UseMiddlewares(AuthMiddleware)
export class SourcingRouter {
  constructor(
    @Inject(SourcingService) private readonly sourcing: SourcingService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInput })
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.sourcing.list(input)
  }

  @Query({ input: quoteIdInput })
  async detail(@Input() input: z.infer<typeof quoteIdInput>) {
    return this.sourcing.detail(input.id)
  }

  @Mutation({ input: requestInput })
  async request(
    @Input() input: z.infer<typeof requestInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['procurement'], 'sourcing.request')
    return db.$transaction(async (tx) => {
      const quotes = await this.sourcing.request(
        input.requisitionId,
        input.vendorIds,
        ctx.user.id,
        tx,
      )
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorKind: ctx.actorKind,
          action: 'sourcing.request',
          entity: 'Quote',
          entityId: quotes.map((q) => q.id).join(','),
          input,
        },
        tx,
      )
      return quotes
    })
  }

  @Mutation({ input: receiveInput })
  async receive(
    @Input() input: z.infer<typeof receiveInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['procurement'], 'sourcing.receive')
    return db.$transaction(async (tx) => {
      const { id, ...offer } = input
      const quote = await this.sourcing.receive(id, offer, tx)
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorKind: ctx.actorKind,
          action: 'sourcing.receive',
          entity: 'Quote',
          entityId: id,
          after: quote as object,
        },
        tx,
      )
      return quote
    })
  }

  /** Pure ranking — read-only, any authenticated principal may consult it. */
  @Query({ input: compareInput })
  async compare(@Input() input: z.infer<typeof compareInput>) {
    return this.sourcing.compare(input.requisitionId)
  }

  @Mutation({ input: quoteIdInput })
  async award(
    @Input() input: z.infer<typeof quoteIdInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    // Award commits spend direction — procurement role, human-gated (§7.2:
    // agents may propose; the award decision is deliberately not grantable).
    requireRole(ctx.user, ctx.actorKind, ['procurement'], 'sourcing.award')
    return db.$transaction(async (tx) => {
      const quote = await this.sourcing.award(input.id, ctx.user.id, tx)
      await this.audit.record(
        {
          actorId: ctx.user.id,
          actorKind: ctx.actorKind,
          action: 'sourcing.award',
          entity: 'Quote',
          entityId: input.id,
          after: quote as object,
        },
        tx,
      )
      return quote
    })
  }
}
