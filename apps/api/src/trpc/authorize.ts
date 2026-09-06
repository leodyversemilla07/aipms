import { TRPCError } from '@trpc/server'
import type { UserKind, UserRole } from '@workspace/db'

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
