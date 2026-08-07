import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { db } from '@workspace/db'
import { type ListInput, type ListResult, paginate } from '../trpc/list-input'

export interface CreateCatalogItem {
  sku: string
  name: string
  category?: string
  unit?: string
  defaultPriceMinor?: number | null
  defaultCurrencyCode?: string
}

export interface UpdateCatalogItem {
  name?: string
  category?: string
  unit?: string
  defaultPriceMinor?: number | null
  defaultCurrencyCode?: string
  active?: boolean
}

@Injectable()
export class CatalogService {
  list(
    input: ListInput,
  ): Promise<ListResult<Prisma.CatalogItemGetPayload<object>>> {
    const { skip, take } = paginate(input)
    const where: Prisma.CatalogItemWhereInput = input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { sku: { contains: input.q, mode: 'insensitive' } },
            { category: { contains: input.q, mode: 'insensitive' } },
          ],
        }
      : {}

    const orderBy: Prisma.CatalogItemOrderByWithRelationInput = (
      {
        sku: { sku: input.dir },
        name: { name: input.dir },
        category: { category: input.dir },
        createdAt: { createdAt: input.dir },
      } as Record<string, Prisma.CatalogItemOrderByWithRelationInput>
    )[input.sort] ?? { createdAt: input.dir }

    return Promise.all([
      db.catalogItem.findMany({ where: where, skip, take, orderBy }),
      db.catalogItem.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const item = await db.catalogItem.findUnique({ where: { id } })
    if (!item) throw new NotFoundException(`Catalog item ${id} not found`)
    return item
  }

  create(input: CreateCatalogItem) {
    return db.catalogItem.create({
      data: {
        sku: input.sku,
        name: input.name,
        category: input.category ?? 'general',
        unit: input.unit ?? 'ea',
        defaultPriceMinor: input.defaultPriceMinor ?? null,
        defaultCurrencyCode: input.defaultCurrencyCode ?? 'PHP',
      },
    })
  }

  async update(id: string, input: UpdateCatalogItem) {
    await this.detail(id)
    return db.catalogItem.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.unit !== undefined && { unit: input.unit }),
        ...(input.defaultPriceMinor !== undefined && {
          defaultPriceMinor: input.defaultPriceMinor,
        }),
        ...(input.defaultCurrencyCode !== undefined && {
          defaultCurrencyCode: input.defaultCurrencyCode,
        }),
        ...(input.active !== undefined && { active: input.active }),
      },
    })
  }

  async deactivate(id: string) {
    await this.detail(id)
    return db.catalogItem.update({
      where: { id },
      data: { active: false },
    })
  }
}
