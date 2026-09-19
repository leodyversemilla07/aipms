import { timingSafeEqual } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { auth, type Session } from '@workspace/auth'
import { fromNodeHeaders } from 'better-auth/node'
import type { Request } from 'express'
import type { ContextOptions, TRPCContext } from 'nestjs-trpc'
import { verifyAgentAccessToken } from '../agent/agent-access-token'
import { resolveAgentScopes } from './agent-capabilities'
import type { BaseTrpcContext } from './context.types'

/**
 * §6 M2M bootstrap identity. Production tRPC calls use short-lived scoped
 * tokens; this legacy id remains for non-production bootstrap compatibility.
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
 * Authenticate machine callers with a signed five-minute bearer. Browser
 * sessions take precedence. The static bootstrap token is accepted directly
 * only outside production; production agents must exchange it at
 * `/api/service/agent/token`. Static comparison remains timing-safe.
 */
function resolveServiceTokenSession(req: Request | undefined): Session | null {
  if (!req) return null
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!token) return null

  const claims = verifyAgentAccessToken(token)
  if (claims) {
    return agentSession(req, token, claims.sub, claims.scopes, claims.exp)
  }

  if (process.env.NODE_ENV === 'production') return null
  const expected = process.env.AIPMS_SERVICE_TOKEN
  if (!expected || token.length !== expected.length) return null
  const [a, b] = [Buffer.from(token), Buffer.from(expected)]
  if (!timingSafeEqual(a, b)) return null
  return agentSession(
    req,
    token,
    AGENT_PRINCIPAL_ID,
    resolveAgentScopes(),
    Math.floor(Date.now() / 1000) + 3600,
  )
}

function agentSession(
  req: Request,
  token: string,
  principalId: string,
  scopes: string[],
  expiresAtSeconds: number,
): Session {
  const now = new Date()
  return {
    session: {
      id: `service:${principalId}`,
      token,
      userId: principalId,
      expiresAt: new Date(expiresAtSeconds * 1000),
      createdAt: now,
      updatedAt: now,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    },
    user: {
      id: principalId,
      name: principalId,
      email: 'machine-principal@agents.aipms.local',
      emailVerified: true,
      image: null,
      kind: 'agent',
      role: 'user',
      scopes,
      quotas: null,
      createdAt: now,
      updatedAt: now,
    },
  } as Session
}
