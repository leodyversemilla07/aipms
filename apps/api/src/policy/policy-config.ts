import { BadRequestException } from '@nestjs/common'
import type { PolicyKind } from '@workspace/db'
import { z } from 'zod'

const scope = z.string().trim().min(1).max(120).optional()
const chain = z.array(z.string().trim().min(1).max(120)).max(50)
const rate = z.number().int().min(0).max(10_000)
const schemas = {
  threshold: z
    .object({
      scope,
      autoApproveUpTo: z.number().int().min(0).max(2_147_483_647).optional(),
      approvalChain: chain.optional(),
      budgetRequired: z.boolean().optional(),
    })
    .strict(),
  preferredVendor: z
    .object({
      scope,
      vendorId: z.string().trim().min(1).max(120).optional(),
      vendor_id: z.string().trim().min(1).max(120).optional(),
    })
    .strict()
    .refine(
      (p) =>
        Boolean(p.vendorId || p.vendor_id) &&
        (!p.vendorId || !p.vendor_id || p.vendorId === p.vendor_id),
      'Provide one unambiguous preferred vendor',
    ),
  evaluationCriterion: z
    .object({
      scope,
      criterion: z.enum(['lowestCost', 'bestValue']),
      priceWeight: z.number().min(0).max(1).optional(),
    })
    .strict(),
  taxRule: z
    .object({
      vatRateBps: rate.optional(),
      ewtRatesBps: z
        .object({
          goods: rate.optional(),
          services: rate.optional(),
          professional: rate.optional(),
          rental: rate.optional(),
          other: rate.optional(),
        })
        .strict()
        .optional(),
      version: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  // These kinds are stored configuration, not newly implemented gates.
  approvalChain: z.object({ scope }).passthrough(),
  budgetControl: z.object({ scope }).passthrough(),
}

export function validatePolicyConfig(kind: PolicyKind, config: unknown) {
  const parsed = schemas[kind].safeParse(config)
  if (!parsed.success)
    throw new BadRequestException(
      `Invalid ${kind} policy: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    )
  // Normalize known scope aliases; keep a single representation for retirement.
  const value = parsed.data as Record<string, unknown>
  if ('scope' in value) {
    const canonical = policyScope(value)
    if (canonical === '*') delete value.scope
    else value.scope = canonical
  }
  return value
}

/** Missing scope is global; bare cost centers and costCenter:<id> are aliases. */
export function policyScope(config: unknown): string {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new BadRequestException('Policy config must be an object')
  const raw = (config as Record<string, unknown>).scope
  if (raw === undefined || raw === null || raw === '' || raw === '*') return '*'
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 120)
    throw new BadRequestException('Invalid policy scope')
  const value = raw.trim()
  const costCenter = value.startsWith('costCenter:')
    ? value.slice('costCenter:'.length)
    : value
  if (!costCenter.trim())
    throw new BadRequestException('Policy scope needs a cost center')
  return `costCenter:${costCenter}`
}
