import { Inject, NotFoundException } from '@nestjs/common'
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
import { CatalogService } from './catalog.service'

const idInput = z.object({ id: z.string().min(1) })

const createCatalogInput = z.object({
  idempotencyKey: z.string().min(1),
  sku: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  category: z.string().max(120).default('general'),
  unit: z.string().max(20).default('ea'),
  defaultPriceMinor: z.number().int().nonnegative().nullable().optional(),
  defaultCurrencyCode: z.string().length(3).default('PHP'),
})

const updateCatalogInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(120).optional(),
  unit: z.string().max(20).optional(),
  defaultPriceMinor: z.number().int().nonnegative().nullable().optional(),
  defaultCurrencyCode: z.string().length(3).optional(),
  active: z.boolean().optional(),
})

const deactivateInput = idInput.extend({
  idempotencyKey: z.string().min(1),
})

@Router({ alias: 'catalog' })
@UseMiddlewares(AuthMiddleware)
export class CatalogRouter {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInput })
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.catalog.list(input)
  }

  @Query({ input: idInput })
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.catalog.detail(input.id)
  }

  @Mutation({ input: createCatalogInput })
  async create(
    @Input() input: z.infer<typeof createCatalogInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'catalog.create',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const item = await this.catalog.create(input, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'catalog.create',
            entity: 'CatalogItem',
            entityId: item.id,
            input,
            after: item,
          },
          tx,
        )
        return item
      },
    )
  }

  @Mutation({ input: updateCatalogInput })
  async update(
    @Input() input: z.infer<typeof updateCatalogInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'catalog.update',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const { id, idempotencyKey: _key, ...rest } = input
        const before = await tx.catalogItem.findUnique({ where: { id } })
        if (!before) throw new NotFoundException(`Catalog item ${id} not found`)
        const item = await this.catalog.update(id, rest, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'catalog.update',
            entity: 'CatalogItem',
            entityId: id,
            input: { id, ...rest },
            before,
            after: item,
          },
          tx,
        )
        return item
      },
    )
  }

  @Mutation({ input: deactivateInput })
  async deactivate(
    @Input() input: z.infer<typeof deactivateInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'catalog.deactivate',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const before = await tx.catalogItem.findUnique({
          where: { id: input.id },
        })
        if (!before)
          throw new NotFoundException(`Catalog item ${input.id} not found`)
        const item = await this.catalog.deactivate(input.id, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'catalog.deactivate',
            entity: 'CatalogItem',
            entityId: input.id,
            before,
            after: item,
          },
          tx,
        )
        return item
      },
    )
  }
}
