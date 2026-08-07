import { Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { db, type PolicyKind } from '@workspace/db'

export interface CreatePolicyInput {
  name: string
  kind: PolicyKind
  config: object
  enabled?: boolean
  supersedesId?: string | null
  updatedBy: string
}

export interface ListPolicyOptions {
  kind?: PolicyKind
  enabled?: boolean
}

@Injectable()
export class PolicyService {
  list(opts: ListPolicyOptions = {}) {
    const where: Prisma.PolicyWhereInput = {}
    if (opts.kind) where.kind = opts.kind
    if (opts.enabled !== undefined) where.enabled = opts.enabled
    return db.policy.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { version: 'desc' }],
    })
  }

  async detail(id: string) {
    const policy = await db.policy.findUnique({ where: { id } })
    if (!policy) throw new NotFoundException(`Policy ${id} not found`)
    return policy
  }

  /** Latest enabled version of each kind — what the §11 engine evaluates against. */
  async activeByKind(): Promise<
    Partial<Record<PolicyKind, Prisma.PolicyGetPayload<object>>>
  > {
    const kinds: PolicyKind[] = [
      'threshold',
      'preferredVendor',
      'approvalChain',
      'budgetControl',
      'evaluationCriterion',
    ]
    const rows = await Promise.all(kinds.map((kind) => this.latest(kind)))

    const active: Record<string, Prisma.PolicyGetPayload<object>> = {}
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]
      const row = rows[i]
      if (!kind || !row) continue
      active[kind] = row
    }
    return active
  }

  async latest(kind: PolicyKind, requireEnabled = true) {
    return db.policy.findFirst({
      where: { kind, ...(requireEnabled && { enabled: true }) },
      orderBy: { version: 'desc' },
    })
  }

  async create(input: CreatePolicyInput) {
    const supersedes = input.supersedesId
      ? await this.detail(input.supersedesId)
      : null

    return db.policy.create({
      data: {
        name: input.name,
        kind: input.kind,
        enabled: input.enabled ?? true,
        version: supersedes ? supersedes.version + 1 : 1,
        supersedesId: supersedes ? supersedes.id : null,
        config: input.config,
        updatedBy: input.updatedBy,
      },
    })
  }
}
