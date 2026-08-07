import type { Prisma } from '@workspace/db'

/**
 * §11 policy engine. Evaluation is a pure function `(policy, context) →
 * decision` invoked inside the same transaction as the guarded mutation.
 * Outcomes are PASS | NEED_APPROVAL | BLOCK, each with citations, so the same
 * engine drives human workflows and (later) agent tool calls.
 *
 * Money is minor units everywhere. Policy config follows the §11 sketch:
 *   { "kind": "threshold", "config": { "scope": "costCenter:eng",
 *       "autoApproveUpTo": 500000, "approvalChain": ["manager","finance","cfo"],
 *       "budgetRequired": true } }
 */

export type PolicyRow = Prisma.PolicyGetPayload<object>

export interface ThresholdPolicyConfig {
  scope?: string
  autoApproveUpTo?: number
  approvalChain?: string[]
  budgetRequired?: boolean
}

export interface GateContext {
  costCenter: string
  amountMinor: number
  /** true when the requisition carries a budgetId, false when none assigned */
  budgetAssigned?: boolean
  /** remaining (limit - committed - spent) at evaluation time */
  budgetRemainingMinor?: number
}

export type GateOutcome = 'PASS' | 'NEED_APPROVAL' | 'BLOCK'
export type GateKind =
  | 'threshold'
  | 'budgetOverride'
  | 'vendorGate'
  | 'policyGate'

export interface GateDecision {
  outcome: GateOutcome
  gateKind: GateKind
  citations: string[]
  approvers?: string[]
  reason: string
}

function scopeApplies(scope: string | undefined, costCenter: string): boolean {
  if (!scope) return true
  const match = /^costCenter:(.+)$/.exec(scope)
  if (match) return match[1] === costCenter
  return scope === costCenter
}

/**
 * Threshold + budget gate for a requisition submit.
 *
 * Conservative by default: no applicable rule means human review, never
 * silent auto-approval (enterprise default). Budget overruns are a
 * NEED_APPROVAL budgetOverride — never silent, per §10.1.
 */
export function evaluateThresholdGate(
  policy: PolicyRow | undefined,
  ctx: GateContext,
): GateDecision {
  const config = (policy?.config ?? {}) as ThresholdPolicyConfig
  const citations: string[] = []
  if (policy) citations.push(`policy:${policy.name}@v${policy.version}`)

  if (ctx.amountMinor <= 0) {
    return {
      outcome: 'BLOCK',
      gateKind: 'policyGate',
      citations,
      reason: 'Amount must be positive',
    }
  }

  if (!policy || !scopeApplies(config.scope, ctx.costCenter)) {
    citations.push('no applicable threshold policy')
    return {
      outcome: 'NEED_APPROVAL',
      gateKind: 'threshold',
      approvers: ['finance'],
      citations,
      reason: 'No threshold rule covers this spend',
    }
  }

  // Budget: when required, an overrun is an explicit override approval.
  if (
    config.budgetRequired &&
    (!ctx.budgetAssigned ||
      (ctx.budgetRemainingMinor !== undefined &&
        ctx.budgetRemainingMinor < ctx.amountMinor))
  ) {
    return {
      outcome: 'NEED_APPROVAL',
      gateKind: 'budgetOverride',
      approvers: config.approvalChain?.length
        ? config.approvalChain
        : ['finance'],
      citations,
      reason: !ctx.budgetAssigned
        ? 'Budget required but none assigned'
        : 'Spend exceeds remaining budget',
    }
  }

  const autoApproveUpTo = config.autoApproveUpTo ?? 0
  if (ctx.amountMinor <= autoApproveUpTo) {
    return {
      outcome: 'PASS',
      gateKind: 'threshold',
      citations,
      reason: `Within auto-approve limit (${autoApproveUpTo} minor units)`,
    }
  }

  return {
    outcome: 'NEED_APPROVAL',
    gateKind: 'threshold',
    approvers: config.approvalChain?.length
      ? config.approvalChain
      : ['finance'],
    citations,
    reason: `Exceeds auto-approve limit (${autoApproveUpTo} minor units)`,
  }
}

/**
 * Vendor gate at PO-issue time (§10.1): blacklisted vendors are a hard BLOCK;
 * unqualified (prospective/watch) vendors need a human vendor-gate approval.
 */
export function evaluateVendorGate(vendorStatus: string): GateDecision {
  if (vendorStatus === 'blacklisted') {
    return {
      outcome: 'BLOCK',
      gateKind: 'vendorGate',
      citations: ['vendor.blacklist'],
      reason: 'Vendor is blacklisted',
    }
  }
  if (vendorStatus !== 'active') {
    return {
      outcome: 'NEED_APPROVAL',
      gateKind: 'vendorGate',
      approvers: ['procurement'],
      citations: [`vendor.status:${vendorStatus}`],
      reason: 'Vendor is not qualified (active)',
    }
  }
  return {
    outcome: 'PASS',
    gateKind: 'vendorGate',
    citations: [],
    reason: 'Vendor qualified',
  }
}
