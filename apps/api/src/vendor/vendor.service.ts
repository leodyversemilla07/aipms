import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { db, type VendorStatus } from '@workspace/db'
import { type ListInput, type ListResult, paginate } from '../trpc/list-input'

export interface CreateVendor {
  name: string
  email?: string | null
  taxId?: string | null
  paymentTermsDays?: number | null
  ratingScore?: number | null
  status?: VendorStatus
}

export interface UpdateVendor {
  name?: string
  email?: string | null
  taxId?: string | null
  paymentTermsDays?: number | null
  ratingScore?: number | null
  status?: VendorStatus
  blacklistReason?: string | null
}

@Injectable()
export class VendorService {
  list(input: ListInput): Promise<ListResult<Prisma.VendorGetPayload<object>>> {
    const { skip, take } = paginate(input)
    const where: Prisma.VendorWhereInput = input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { email: { contains: input.q, mode: 'insensitive' } },
            { taxId: { contains: input.q, mode: 'insensitive' } },
          ],
        }
      : {}

    const orderBy: Prisma.VendorOrderByWithRelationInput = (
      {
        name: { name: input.dir },
        status: { status: input.dir },
        ratingScore: { ratingScore: input.dir },
        createdAt: { createdAt: input.dir },
      } as Record<string, Prisma.VendorOrderByWithRelationInput>
    )[input.sort] ?? { createdAt: input.dir }

    return Promise.all([
      db.vendor.findMany({ where: where, skip, take, orderBy }),
      db.vendor.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const vendor = await db.vendor.findUnique({ where: { id } })
    if (!vendor) throw new NotFoundException(`Vendor ${id} not found`)
    return vendor
  }

  create(input: CreateVendor) {
    return db.vendor.create({
      data: {
        name: input.name,
        email: input.email ?? null,
        taxId: input.taxId ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        ratingScore: input.ratingScore ?? null,
        status: input.status ?? 'prospective',
      },
    })
  }

  async update(id: string, input: UpdateVendor) {
    await this.detail(id)
    return db.vendor.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.taxId !== undefined && { taxId: input.taxId }),
        ...(input.paymentTermsDays !== undefined && {
          paymentTermsDays: input.paymentTermsDays,
        }),
        ...(input.ratingScore !== undefined && {
          ratingScore: input.ratingScore,
        }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.blacklistReason !== undefined && {
          blacklistReason: input.blacklistReason,
        }),
      },
    })
  }
}
