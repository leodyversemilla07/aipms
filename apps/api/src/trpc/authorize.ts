import { TRPCError } from '@trpc/server'
import type { UserKind, UserRole } from '@workspace/db'

/**
 * Human authorization policy for the complete tRPC surface. Keeping this at
 * the authentication boundary makes new procedures fail closed instead of
 * relying on every router author to remember a local role check.
 *
 * `admin` is an implicit member of every grant. Agent principals never use
 * this table: their separate capability map remains default-deny.
 */
export const HUMAN_PROCEDURE_ROLES: Record<string, readonly UserRole[]> = {
  'users.me': ['user', 'procurement', 'finance'],
  'users.list': ['admin'],

  'catalog.list': ['user', 'procurement', 'finance'],
  'catalog.detail': ['user', 'procurement', 'finance'],
  'catalog.create': ['procurement'],
  'catalog.update': ['procurement'],
  'catalog.deactivate': ['procurement'],

  'vendor.list': ['procurement', 'finance'],
  'vendor.detail': ['procurement', 'finance'],
  'vendor.create': ['procurement'],
  'vendor.update': ['procurement'],
  'vendor.verifyBankAccount': ['finance'],

  'requisition.list': ['user', 'procurement', 'finance'],
  'requisition.detail': ['user', 'procurement', 'finance'],
  'requisition.exceptionQueue': ['procurement', 'finance'],
  'requisition.create': ['user', 'procurement', 'finance'],
  'requisition.submit': ['user', 'procurement', 'finance'],

  'sourcing.list': ['procurement', 'finance'],
  'sourcing.detail': ['procurement', 'finance'],
  'sourcing.request': ['procurement', 'finance'],
  'sourcing.receive': ['procurement', 'finance'],
  'sourcing.compare': ['procurement', 'finance'],
  'sourcing.award': ['procurement'],

  'approval.pendingList': ['procurement', 'finance'],
  'approval.detail': ['procurement', 'finance'],
  'approval.decide': ['procurement', 'finance'],

  'budget.list': ['user', 'procurement', 'finance'],
  'budget.detail': ['user', 'procurement', 'finance'],
  'budget.create': ['finance'],

  'purchaseOrder.list': ['procurement', 'finance'],
  'purchaseOrder.detail': ['procurement', 'finance'],
  'purchaseOrder.signature': ['procurement', 'finance'],
  'purchaseOrder.sign': ['procurement', 'finance'],
  'purchaseOrder.issue': ['procurement', 'finance'],
  'purchaseOrder.confirm': ['procurement', 'finance'],
  'purchaseOrder.requestCancellation': ['procurement', 'finance'],

  'receipt.list': ['procurement', 'finance'],
  'receipt.detail': ['procurement', 'finance'],
  'receipt.record': ['procurement', 'finance'],
  'receipt.cancel': ['procurement', 'finance'],

  'invoice.list': ['finance'],
  'invoice.detail': ['finance'],
  'invoice.compute': ['finance'],
  'invoice.register': ['finance'],

  'intake.list': ['finance'],
  'intake.ingest': ['finance'],
  'intake.ingestStructured': ['finance'],
  'intake.classify': ['finance'],
  'intake.drop': ['finance'],
  'intake.requeue': ['finance'],
  'intake.registerInvoice': ['finance'],

  'messaging.list': ['procurement', 'finance'],
  'messaging.detail': ['procurement', 'finance'],
  'messaging.submit': ['procurement', 'finance'],
  'messaging.approve': ['procurement', 'finance'],
  'messaging.reject': ['procurement', 'finance'],

  'paymentRun.list': ['finance'],
  'paymentRun.detail': ['finance'],
  'paymentRun.batch': ['finance'],
  'paymentRun.create': ['finance'],
  'paymentRun.approve': ['finance'],
  'paymentRun.execute': ['finance'],
  'paymentRun.reconcile': ['finance'],
  'paymentRun.voidRun': ['finance'],

  'policy.list': ['procurement', 'finance'],
  'policy.detail': ['procurement', 'finance'],
  'policy.activeByKind': ['procurement', 'finance'],
  'policy.create': ['admin'],

  'audit.list': ['finance'],
  'audit.meta': ['finance'],
  'audit.chain': ['finance'],

  'bir.certificate': ['finance'],
  'bir.remittance': ['finance'],
  'bir.periods': ['finance'],

  'erp.exportRun': ['finance'],
  'erp.list': ['finance'],
  'erp.manifest': ['finance'],
  'erp.acknowledge': ['finance'],
  'erp.ingestVendors': ['finance'],
  'erp.reconcileReport': ['finance'],
  'erp.qboStatus': ['finance'],
  'erp.qboAuthorize': ['finance'],
  'erp.qboDisconnect': ['finance'],
  'erp.qboSyncAccounts': ['finance'],
  'erp.qboSetAccountMap': ['finance'],
  'erp.qboPushExport': ['finance'],

  'analytics.overview': ['procurement', 'finance'],
  'analytics.runTrace': ['procurement', 'finance'],

  'agent.process': ['admin'],
  'agent.batch': ['admin'],
  'agent.runs': ['procurement', 'finance'],
  'events.poll': ['admin'],

  'sso.listProviders': ['admin'],
  'sso.listScimConnections': ['admin'],
  'sso.registerProvider': ['admin'],
  'sso.deleteProvider': ['admin'],
  'sso.generateScimToken': ['admin'],
}

/** Enforce the centralized human role matrix; unknown procedures fail closed. */
export function assertHumanProcedureRole(path: string, role: UserRole): void {
  const roles = HUMAN_PROCEDURE_ROLES[path]
  if (!roles) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Human access to ${path} is not configured`,
    })
  }
  if (role === 'admin' || roles.includes(role)) return
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `${path} requires role: ${roles.join(' or ')}`,
  })
}

/**
 * §10 authorization. Role gates on router mutations: `actorKind === 'agent'`
 * (service-token principal) is governed by its scopes, not roles, so it is
 * exempt here; humans must hold one of `roles` (or `admin`, which bypasses
 * membership — decisions are still audited).
 */
export function requireRole(
  user: { role?: UserRole } | undefined,
  actorKind: UserKind,
  roles: UserRole[],
  action: string,
) {
  if (actorKind === 'agent') return
  const role = user?.role ?? 'user'
  if (role === 'admin' || roles.includes(role)) return
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: `${action} requires role: ${roles.join(' or ')}`,
  })
}

/** Human approval authority cannot be granted through a machine scope. */
export function requireHumanRole(
  user: { role?: UserRole } | undefined,
  actorKind: UserKind,
  roles: UserRole[],
  action: string,
) {
  if (actorKind !== 'human') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `${action} requires a human with role: ${roles.join(' or ')}`,
    })
  }
  requireRole(user, actorKind, roles, action)
}
