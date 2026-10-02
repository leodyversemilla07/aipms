import { ConflictException } from '@nestjs/common'
import { db, type PolicyKind, type Prisma } from '@workspace/db'
import { policyScope, validatePolicyConfig } from './policy-config'

export const POLICY_ORDER = [
  { version: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.PolicyOrderByWithRelationInput[]
export interface PolicyContext {
  costCenter?: string
}

/**
 * Exact cost-center rules override global rules. Version orders each scope.
 * Legacy equal-version heads are ambiguous: no arbitrary id/edit-time winner.
 */
export async function resolveEffectivePolicy(
  kind: PolicyKind,
  context: PolicyContext = {},
  client: Prisma.TransactionClient = db,
) {
  const rows = await client.policy.findMany({
    where: { kind, enabled: true },
    orderBy: POLICY_ORDER,
  })
  const scoped = context.costCenter ? `costCenter:${context.costCenter}` : null
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = policyScope(row.config)
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const candidates =
    (scoped && groups.get(scoped)?.length
      ? groups.get(scoped)
      : groups.get('*')) ?? []
  const head = candidates[0]
  if (!head) return null
  if (
    !Number.isSafeInteger(head.version) ||
    head.version < 1 ||
    candidates.some((row) => row.id !== head.id && row.version === head.version)
  ) {
    throw new ConflictException(
      `Ambiguous ${kind} policy head; publish a reviewed replacement revision`,
    )
  }
  const config = validatePolicyConfig(kind, head.config)
  return { ...head, config: config as Prisma.JsonObject }
}
