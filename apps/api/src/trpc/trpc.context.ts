import { timingSafeEqual } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { auth, type Session } from '@workspace/auth'
import { fromNodeHeaders } from 'better-auth/node'
import type { ContextOptions, TRPCContext } from 'nestjs-trpc'
import type { Request } from 'express'
import { resolveAgentScopes } from './agent-capabilities'
import type { BaseTrpcContext } from './context.types'

/**
 * §6 M2M identity — the synthetic principal behind `AIPMS_SERVICE_TOKEN`.
 * Agent actions are audited with this id and `actorKind: 'agent'`.
 */
export const AGENT_PRINCIPAL_ID = 'agent-operator'

@Injectable()
export class TrpcContext implements TRPCContext {
  async create(opts: ContextOptions): Promise<BaseTrpcContext> {
    const req = 'req' in opts ? opts.req : undefined
    const session = req
      ? await auth.api
          .getSession({ headers: fromNodeHeaders(req.headers) })
          .catch(() => null)
      : null
    return { req, session: session ?? resolveServiceTokenSession(req) }
  }
}

/**
 * Authenticate machine callers via `Authorization: Bearer <AIPMS_SERVICE_TOKEN>`.
 * Browser sessions take precedence; the service token only applies when no
 * Better Auth session is present, so agents can drive tRPC procedures without
 * a cookie. Comparison is timing-safe.
 */
function resolveServiceTokenSession(req: Request | undefined): Session | null {
  if (!req) return null
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  const expected = process.env.AIPMS_SERVICE_TOKEN
  if (!expected || !token || token.length !== expected.length) return null
  const [a, b] = [Buffer.from(token), Buffer.from(expected)]
  if (!timingSafeEqual(a, b)) return null

  const now = new Date()
  return {
    session: {
      id: `service:${AGENT_PRINCIPAL_ID}`,
      token,
      userId: AGENT_PRINCIPAL_ID,
      expiresAt: new Date(now.getTime() + 3600_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    },
    user: {
      id: AGENT_PRINCIPAL_ID,
      name: 'Agent Operator',
      email: 'agent@aipms.local',
      emailVerified: true,
      image: null,
      kind: 'agent',
      role: 'user',
      scopes: resolveAgentScopes(),
      quotas: null,
      createdAt: now,
      updatedAt: now,
    },
  } as Session
}