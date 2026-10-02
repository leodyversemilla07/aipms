import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type PolicyKind, Prisma } from '@workspace/db'
import {
  normalizeTaxPolicy,
  PH_DEFAULT_POLICY,
  type TaxPolicyConfig,
} from '@workspace/tax'
import { policyScope, validatePolicyConfig } from './policy-config'
import {
  POLICY_ORDER,
  type PolicyContext,
  resolveEffectivePolicy,
} from './policy-resolver'

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
      orderBy: [{ kind: 'asc' }, ...POLICY_ORDER],
    })
  }

  async detail(id: string) {
    const policy = await db.policy.findUnique({ where: { id } })
    if (!policy) throw new NotFoundException(`Policy ${id} not found`)
    return policy
  }

  async activeByKind(
    context: PolicyContext = {},
  ): Promise<Partial<Record<PolicyKind, Prisma.PolicyGetPayload<object>>>> {
    const kinds: PolicyKind[] = [
      'threshold',
      'preferredVendor',
      'approvalChain',
      'budgetControl',
      'evaluationCriterion',
      'taxRule',
    ]
    const rows = await Promise.all(
      kinds.map((kind) => this.resolve(kind, context)),
    )
    const active: Partial<Record<PolicyKind, Prisma.PolicyGetPayload<object>>> =
      {}
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]
      const row = rows[i]
      if (kind && row) active[kind] = row
    }
    return active
  }

  resolve(
    kind: PolicyKind,
    context: PolicyContext = {},
    client: Prisma.TransactionClient = db,
  ) {
    return resolveEffectivePolicy(kind, context, client)
  }

  /** Historical lookup ignores scope/enabled; operative lookup is global-only. */
  latest(kind: PolicyKind, requireEnabled = true) {
    return requireEnabled
      ? this.resolve(kind)
      : db.policy.findFirst({ where: { kind }, orderBy: POLICY_ORDER })
  }

  async taxConfig(
    client: Prisma.TransactionClient = db,
  ): Promise<TaxPolicyConfig> {
    const policy = await this.resolve('taxRule', {}, client)
    if (!policy) return PH_DEFAULT_POLICY
    return {
      ...normalizeTaxPolicy(policy.config),
      version: `policy:${policy.id}@v${policy.version}`,
    }
  }

  async create(input: CreatePolicyInput, outerTx?: Prisma.TransactionClient) {
    const config = validatePolicyConfig(input.kind, input.config)
    const scope = policyScope(config)
    const run = async (tx: Prisma.TransactionClient) => {
      // Same kind => one allocator, including standalone callers and router txs.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`policy-version:${input.kind}`}))`
      const latest = await tx.policy.findFirst({
        where: { kind: input.kind },
        orderBy: POLICY_ORDER,
      })
      const version = (latest?.version ?? 0) + 1
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > 2_147_483_647
      )
        throw new ConflictException('Policy version range exhausted or corrupt')
      const peers = await tx.policy.findMany({
        where: { kind: input.kind },
        orderBy: POLICY_ORDER,
      })
      const sameScope = peers.filter((row) => policyScope(row.config) === scope)
      const supersedes = input.supersedesId
        ? await tx.policy.findUnique({ where: { id: input.supersedesId } })
        : null
      if (input.supersedesId && !supersedes)
        throw new NotFoundException(`Policy ${input.supersedesId} not found`)
      if (
        supersedes &&
        (supersedes.kind !== input.kind ||
          policyScope(supersedes.config) !== scope)
      )
        throw new BadRequestException(
          'Supersession must stay within the same policy kind and scope',
        )
      if (supersedes && supersedes.version !== sameScope[0]?.version)
        throw new ConflictException(
          'Supersession target is stale; reload the policy head',
        )
      const retiredPolicyIds =
        input.enabled === false
          ? []
          : sameScope.filter((row) => row.enabled).map((row) => row.id)
      if (retiredPolicyIds.length)
        await tx.policy.updateMany({
          where: { id: { in: retiredPolicyIds }, enabled: true },
          data: { enabled: false },
        })
      const created = await tx.policy.create({
        data: {
          name: input.name,
          kind: input.kind,
          enabled: input.enabled ?? true,
          version,
          supersedesId: supersedes?.id ?? null,
          config: config as Prisma.InputJsonObject,
          updatedBy: input.updatedBy,
        },
      })
      // The router's atomic audit records which immutable revisions were retired.
      return { ...created, retiredPolicyIds }
    }
    return outerTx ? run(outerTx) : db.$transaction(run)
  }
}
