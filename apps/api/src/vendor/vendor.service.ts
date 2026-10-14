import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma, type VendorStatus } from '@workspace/db'
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

export interface VerifyContactInput {
  email: string
  evidence: string
}

export interface RevokeContactInput {
  email: string
  reason?: string | null
}

export interface VerifiedContactEntry {
  email: string
  verifiedAt: string
  verifiedBy: string
  evidence: string
}

export interface VendorContactChannels {
  verifiedEmails: string[]
  entries?: VerifiedContactEntry[]
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeContactEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!normalized || !EMAIL_REGEX.test(normalized) || normalized.length > 254) {
    throw new BadRequestException(`Invalid contact email address: ${email}`)
  }
  return normalized
}

/**
 * Safe vendor DTO shared by every browser-facing vendor operation. Beneficiary
 * account numbers are intentionally absent; payment services read them through
 * their internal database boundary and the UI only receives verification state.
 */
export const vendorViewSelect = {
  id: true,
  name: true,
  status: true,
  email: true,
  taxId: true,
  paymentTermsDays: true,
  ratingScore: true,
  qualifiedEntityClass: true,
  blacklistReason: true,
  contactChannels: true,
  bankAccountVerifiedAt: true,
  bankAccountChangedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VendorSelect

export type VendorView = Prisma.VendorGetPayload<{
  select: typeof vendorViewSelect
}>

function normalizeBankAccount(value: unknown) {
  const account = value as Record<string, unknown>
  return {
    bank: String(account.bank ?? '').trim(),
    accountNumber: String(
      account.accountNumber ?? account.accountNo ?? '',
    ).trim(),
    holder: String(account.holder ?? '').trim(),
  }
}

@Injectable()
export class VendorService {
  list(input: ListInput): Promise<ListResult<VendorView>> {
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

    const primaryOrderBy: Prisma.VendorOrderByWithRelationInput = (
      {
        name: { name: input.dir },
        status: { status: input.dir },
        ratingScore: { ratingScore: input.dir },
        createdAt: { createdAt: input.dir },
      } as Record<string, Prisma.VendorOrderByWithRelationInput>
    )[input.sort] ?? { createdAt: input.dir }
    const orderBy: Prisma.VendorOrderByWithRelationInput[] = [
      primaryOrderBy,
      { id: 'asc' },
    ]

    return Promise.all([
      db.vendor.findMany({
        where,
        skip,
        take,
        orderBy,
        select: vendorViewSelect,
      }),
      db.vendor.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const vendor = await db.vendor.findUnique({
      where: { id },
      select: vendorViewSelect,
    })
    if (!vendor) throw new NotFoundException(`Vendor ${id} not found`)
    return vendor
  }

  /**
   * §8.6 beneficiary maker/checker control. The first finance principal
   * submits an account and makes it non-payable. A different finance principal
   * must submit the identical normalized account to verify it.
   */
  async verifyBankAccount(
    vendorId: string,
    bankAccount: unknown,
    actorId: string,
    outerTx?: Prisma.TransactionClient,
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM vendor WHERE id = ${vendorId} FOR UPDATE`
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId } })
      if (!vendor) throw new NotFoundException(`Vendor ${vendorId} not found`)

      const next = normalizeBankAccount(bankAccount)
      if (!next.bank || !next.accountNumber || !next.holder) {
        throw new BadRequestException(
          'Bank, account number, and holder are required',
        )
      }
      const previous = vendor.bankAccount
        ? normalizeBankAccount(vendor.bankAccount)
        : null
      const sameAccount =
        previous !== null && JSON.stringify(previous) === JSON.stringify(next)

      if (vendor.bankAccountChangedAt && sameAccount) {
        if (vendor.bankAccountSubmittedBy === actorId) {
          throw new ForbiddenException(
            'Beneficiary verification requires a different finance user',
          )
        }
        return tx.vendor.update({
          where: { id: vendorId },
          data: {
            bankAccountVerifiedAt: new Date(),
            bankAccountVerifiedBy: actorId,
            bankAccountChangedAt: null,
            bankAccountSubmittedBy: null,
          },
          select: vendorViewSelect,
        })
      }

      if (sameAccount && vendor.bankAccountVerifiedAt) {
        return tx.vendor.findUniqueOrThrow({
          where: { id: vendorId },
          select: vendorViewSelect,
        })
      }

      return tx.vendor.update({
        where: { id: vendorId },
        data: {
          bankAccount: next as Prisma.InputJsonValue,
          bankAccountVerifiedAt: null,
          bankAccountVerifiedBy: null,
          bankAccountChangedAt: new Date(),
          bankAccountSubmittedBy: actorId,
        },
        select: vendorViewSelect,
      })
    }

    return outerTx ? run(outerTx) : db.$transaction(run)
  }

  /**
   * §8.3 / §16: enroll and verify a contact channel (email) for outbound messaging.
   * Requires human procurement or finance authority with verifiable evidence.
   */
  async verifyContact(
    vendorId: string,
    input: VerifyContactInput,
    actorId: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<VendorView> {
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM vendor WHERE id = ${vendorId} FOR UPDATE`
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId } })
      if (!vendor) throw new NotFoundException(`Vendor ${vendorId} not found`)

      if (vendor.status === 'blacklisted') {
        throw new ForbiddenException(
          `Vendor ${vendor.name} is blacklisted — contact verification blocked`,
        )
      }

      const email = normalizeContactEmail(input.email)
      const evidence = input.evidence.trim()
      if (!evidence || evidence.length < 5) {
        throw new BadRequestException(
          'Verification evidence must be at least 5 characters',
        )
      }

      const existing = (vendor.contactChannels ??
        {}) as Partial<VendorContactChannels>
      const existingEmails = Array.isArray(existing.verifiedEmails)
        ? existing.verifiedEmails.filter(
            (e): e is string => typeof e === 'string',
          )
        : []
      const existingEntries = Array.isArray(existing.entries)
        ? existing.entries.filter((entry): entry is VerifiedContactEntry =>
            Boolean(
              entry &&
                typeof entry === 'object' &&
                typeof (entry as VerifiedContactEntry).email === 'string',
            ),
          )
        : []

      const now = new Date().toISOString()
      const nextEmails = [...new Set([...existingEmails, email])]
      const filteredEntries = existingEntries.filter(
        (entry) => entry.email !== email,
      )
      const nextEntries: VerifiedContactEntry[] = [
        ...filteredEntries,
        {
          email,
          verifiedAt: now,
          verifiedBy: actorId,
          evidence,
        },
      ]

      const nextChannels: VendorContactChannels = {
        verifiedEmails: nextEmails,
        entries: nextEntries,
      }

      return tx.vendor.update({
        where: { id: vendorId },
        data: {
          contactChannels: nextChannels as unknown as Prisma.InputJsonValue,
        },
        select: vendorViewSelect,
      })
    }

    return outerTx ? run(outerTx) : db.$transaction(run)
  }

  /**
   * Revoke an enrolled contact channel with change invalidation.
   */
  async revokeContact(
    vendorId: string,
    input: RevokeContactInput,
    _actorId: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<VendorView> {
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM vendor WHERE id = ${vendorId} FOR UPDATE`
      const vendor = await tx.vendor.findUnique({ where: { id: vendorId } })
      if (!vendor) throw new NotFoundException(`Vendor ${vendorId} not found`)

      const email = normalizeContactEmail(input.email)
      const existing = (vendor.contactChannels ??
        {}) as Partial<VendorContactChannels>
      const existingEmails = Array.isArray(existing.verifiedEmails)
        ? existing.verifiedEmails.filter(
            (e): e is string => typeof e === 'string',
          )
        : []
      const existingEntries = Array.isArray(existing.entries)
        ? existing.entries.filter((entry): entry is VerifiedContactEntry =>
            Boolean(
              entry &&
                typeof entry === 'object' &&
                typeof (entry as VerifiedContactEntry).email === 'string',
            ),
          )
        : []

      if (!existingEmails.includes(email)) {
        throw new NotFoundException(
          `Contact email ${email} is not enrolled for ${vendor.name}`,
        )
      }

      const nextEmails = existingEmails.filter((e) => e !== email)
      const nextEntries = existingEntries.filter(
        (entry) => entry.email !== email,
      )

      const nextChannels: VendorContactChannels = {
        verifiedEmails: nextEmails,
        entries: nextEntries,
      }

      return tx.vendor.update({
        where: { id: vendorId },
        data: {
          contactChannels: nextChannels as unknown as Prisma.InputJsonValue,
        },
        select: vendorViewSelect,
      })
    }

    return outerTx ? run(outerTx) : db.$transaction(run)
  }

  create(input: CreateVendor, tx: Prisma.TransactionClient = db) {
    return tx.vendor.create({
      data: {
        name: input.name,
        email: input.email ?? null,
        taxId: input.taxId ?? null,
        paymentTermsDays: input.paymentTermsDays ?? null,
        ratingScore: input.ratingScore ?? null,
        status: input.status ?? 'prospective',
      },
      select: vendorViewSelect,
    })
  }

  async update(
    id: string,
    input: UpdateVendor,
    tx: Prisma.TransactionClient = db,
  ) {
    const existing = await tx.vendor.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException(`Vendor ${id} not found`)
    const isBlacklisting = input.status === 'blacklisted'
    const nextChannels = isBlacklisting
      ? { verifiedEmails: [], entries: [] }
      : undefined
    return tx.vendor.update({
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
        ...(nextChannels !== undefined && {
          contactChannels: nextChannels as unknown as Prisma.InputJsonValue,
        }),
      },
      select: vendorViewSelect,
    })
  }
}
