import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const ISSUER = 'aipms-api'
const AUDIENCE = 'aipms-trpc'
const MAX_TTL_SECONDS = 300

export interface AgentAccessClaims {
  iss: typeof ISSUER
  aud: typeof AUDIENCE
  sub: string
  kind: 'agent'
  scopes: string[]
  iat: number
  exp: number
  jti: string
  runId?: string
}

function signingSecret(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.AIPMS_AGENT_SIGNING_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'AIPMS_AGENT_SIGNING_SECRET must contain at least 32 characters',
    )
  }
  return secret
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function signature(input: string, env: NodeJS.ProcessEnv = process.env) {
  return createHmac('sha256', signingSecret(env))
    .update(input)
    .digest('base64url')
}

export function issueAgentAccessToken(
  input: {
    subject: string
    scopes: string[]
    runId?: string
    ttlSeconds?: number
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(input.subject)) {
    throw new Error('Agent token subject contains invalid characters')
  }
  if (!input.scopes.every((scope) => /^[a-zA-Z0-9._-]{1,128}$/.test(scope))) {
    throw new Error('Agent token scope contains invalid characters')
  }
  if (input.runId && !/^[a-zA-Z0-9:_-]{1,128}$/.test(input.runId)) {
    throw new Error('Agent token runId contains invalid characters')
  }
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(30, input.ttlSeconds ?? MAX_TTL_SECONDS),
  )
  const claims: AgentAccessClaims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: input.subject,
    kind: 'agent',
    scopes: [...new Set(input.scopes)].sort(),
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
    ...(input.runId ? { runId: input.runId } : {}),
  }
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return {
    accessToken: `${unsigned}.${signature(unsigned, env)}`,
    tokenType: 'Bearer' as const,
    expiresIn: ttl,
    expiresAt: new Date((now + ttl) * 1000).toISOString(),
  }
}

export function verifyAgentAccessToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentAccessClaims | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerPart, claimsPart, providedPart] = parts
    if (!headerPart || !claimsPart || !providedPart) return null
    const header = JSON.parse(
      Buffer.from(headerPart, 'base64url').toString('utf8'),
    ) as { alg?: unknown; typ?: unknown }
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null

    const expectedPart = signature(`${headerPart}.${claimsPart}`, env)
    const provided = Buffer.from(providedPart)
    const expected = Buffer.from(expectedPart)
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return null
    }

    const claims = JSON.parse(
      Buffer.from(claimsPart, 'base64url').toString('utf8'),
    ) as Partial<AgentAccessClaims>
    const now = Math.floor(Date.now() / 1000)
    if (
      claims.iss !== ISSUER ||
      claims.aud !== AUDIENCE ||
      claims.kind !== 'agent' ||
      typeof claims.sub !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(claims.sub) ||
      !Array.isArray(claims.scopes) ||
      !claims.scopes.every(
        (scope) =>
          typeof scope === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(scope),
      ) ||
      (claims.runId !== undefined &&
        (typeof claims.runId !== 'string' ||
          !/^[a-zA-Z0-9:_-]{1,128}$/.test(claims.runId))) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      typeof claims.jti !== 'string' ||
      claims.iat > now + 30 ||
      claims.exp <= now ||
      claims.exp - claims.iat > MAX_TTL_SECONDS
    ) {
      return null
    }
    return claims as AgentAccessClaims
  } catch {
    return null
  }
}
