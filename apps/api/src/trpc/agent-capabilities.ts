import { TRPCError } from '@trpc/server'

/**
 * §7.2 capability model — agents are governed by explicit scopes, never by
 * roles. Every tRPC procedure an agent may call is listed here with the scope
 * it requires; **absence from the map means agents are denied** (default
 * deny). Humans bypass this layer entirely and are governed by role gates.
 *
 * Deliberately ungrantable (no capability exists): purchaseOrder.sign (§16.4
 * humans countersign), sso.* (identity admin), paymentRun.* (§8.6 no single
 * principal moves money), vendor.verifyBankAccount (beneficiary control),
 * messaging.approve / messaging.reject (§8.3 gated-send review is human),
 * users.list, policy.create, budget.create, approval.decide (route
 * membership decides).
 */

export const AGENT_CAPABILITIES: Record<string, string> = {
  // Catalog
  'catalog.list': 'catalog.read',
  'catalog.detail': 'catalog.read',
  'catalog.create': 'catalog.write',
  'catalog.update': 'catalog.write',
  'catalog.deactivate': 'catalog.write',

  // Vendor
  'vendor.list': 'vendor.read',
  'vendor.detail': 'vendor.read',
  'vendor.create': 'vendor.write',
  'vendor.update': 'vendor.write',

  // Requisition
  'requisition.list': 'requisition.read',
  'requisition.detail': 'requisition.read',
  'requisition.exceptionQueue': 'requisition.read',
  'requisition.create': 'requisition.create',
  'requisition.submit': 'requisition.submit',

  // Budget
  'budget.list': 'budget.read',
  'budget.detail': 'budget.read',

  // Purchase orders
  'purchaseOrder.list': 'po.read',
  'purchaseOrder.detail': 'po.read',
  'purchaseOrder.signature': 'po.read',
  'purchaseOrder.issue': 'po.issue',
  'purchaseOrder.confirm': 'po.confirm',
  'purchaseOrder.requestCancellation': 'po.cancel',

  // Invoices & intake
  'invoice.list': 'invoice.read',
  'invoice.detail': 'invoice.read',
  'invoice.compute': 'invoice.read',
  'invoice.register': 'invoice.ingest',
  // §8.1 receipts (three-way match leg)
  'receipt.list': 'receipt.read',
  'receipt.detail': 'receipt.read',
  'receipt.record': 'receipt.record',
  'intake.list': 'intake.read',
  'intake.ingest': 'intake.ingest',
  'intake.ingestStructured': 'intake.ingest',
  'intake.classify': 'intake.classify',
  'intake.drop': 'intake.drop',
  'intake.requeue': 'intake.requeue',
  'intake.registerInvoice': 'invoice.ingest',

  // §8.3 messaging relay — submit is tiered server-side (auto/gated);
  // approve/reject are deliberately absent: humans review gated drafts.
  'messaging.list': 'messaging.read',
  'messaging.detail': 'messaging.read',
  'messaging.submit': 'messaging.submit',

  // Policy (read-only; authoring is human-admin)
  'policy.list': 'policy.read',
  'policy.detail': 'policy.read',
  'policy.activeByKind': 'policy.read',

  // Events & audit
  'events.poll': 'events.poll',
  'audit.list': 'audit.read',
  'audit.meta': 'audit.read',
  'audit.chain': 'audit.read',

  // §8.4 BIR statutory reports (derived read-only from stored tax data)
  'bir.certificate': 'invoice.read',
  'bir.remittance': 'invoice.read',
  'bir.periods': 'invoice.read',

  // Agent runs — scoped agents may inspect the run history (§7.1)
  'agent.runs': 'agent.read',
}

/**
 * Self-info is available to every authenticated principal — it carries no
 * authority beyond reflecting the caller's own session.
 */
const ALWAYS_ALLOWED = new Set(['users.me'])

/**
 * The operator workflow (§7.5 Phase-1 single operator): drain intake,
 * classify/register invoices, drive requisition→PO, read everything needed
 * to decide. Money movement, bank verification, identity and policy
 * authoring are excluded — grant them explicitly if ever needed.
 */
export const DEFAULT_AGENT_SCOPES = [
  'catalog.read',
  'vendor.read',
  'requisition.read',
  'requisition.create',
  'requisition.submit',
  'budget.read',
  'po.read',
  'po.issue',
  'po.confirm',
  'po.cancel',
  'invoice.read',
  'invoice.ingest',
  'receipt.read',
  'receipt.record',
  'messaging.read',
  'messaging.submit',
  'intake.read',
  'intake.ingest',
  'intake.classify',
  'intake.drop',
  'intake.requeue',
  'policy.read',
  'events.poll',
  'audit.read',
]

/**
 * `AIPMS_AGENT_SCOPES` — comma-separated explicit grant set; when set it
 * REPLACES the defaults entirely (least privilege is opt-down, not opt-up).
 */
export function resolveAgentScopes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.AIPMS_AGENT_SCOPES
  if (raw === undefined) return [...DEFAULT_AGENT_SCOPES]
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** True when the agent principal may invoke `path` with `scopes`. */
export function agentMayInvoke(
  path: string,
  scopes: Iterable<string>,
): boolean {
  if (ALWAYS_ALLOWED.has(path)) return true
  const required = AGENT_CAPABILITIES[path]
  if (!required) return false
  return new Set(scopes).has(required)
}

/** tRPC-shaped refusal with a readable reason (§7.4 fail visible). */
export function assertAgentCapability(
  path: string,
  scopes: Iterable<string>,
): void {
  if (agentMayInvoke(path, scopes)) return

  const required = AGENT_CAPABILITIES[path]
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: !required
      ? `Agents are not permitted to call ${path} — this surface is reserved for humans`
      : `Agent lacks required scope "${required}" for ${path}`,
  })
}
