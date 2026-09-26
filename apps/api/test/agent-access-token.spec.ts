import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueAgentAccessToken,
  verifyAgentAccessToken,
} from '../src/agent/agent-access-token'

const env = {
  AIPMS_AGENT_SIGNING_SECRET:
    'test-agent-signing-secret-that-is-long-enough-123456',
} as NodeJS.ProcessEnv

afterEach(() => vi.useRealTimers())

describe('short-lived agent access tokens', () => {
  it('round-trips identity, scopes, and run attribution', () => {
    const issued = issueAgentAccessToken(
      {
        subject: 'agent:sourcing-1',
        scopes: ['sourcing.read', 'sourcing.request', 'sourcing.read'],
        runId: 'run-123',
      },
      env,
    )
    const claims = verifyAgentAccessToken(issued.accessToken, env)
    expect(claims).toMatchObject({
      sub: 'agent:sourcing-1',
      kind: 'agent',
      scopes: ['sourcing.read', 'sourcing.request'],
      runId: 'run-123',
    })
    expect(issued.expiresIn).toBe(300)
  })

  it('rejects tampering and a different signing key', () => {
    const issued = issueAgentAccessToken(
      { subject: 'agent-1', scopes: ['catalog.read'] },
      env,
    )
    expect(
      verifyAgentAccessToken(`${issued.accessToken.slice(0, -1)}x`, env),
    ).toBeNull()
    expect(
      verifyAgentAccessToken(issued.accessToken, {
        AIPMS_AGENT_SIGNING_SECRET:
          'different-signing-secret-that-is-long-enough-987654',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  it('rejects expired tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const issued = issueAgentAccessToken(
      { subject: 'agent-1', scopes: [], ttlSeconds: 30 },
      env,
    )
    vi.advanceTimersByTime(31_000)
    expect(verifyAgentAccessToken(issued.accessToken, env)).toBeNull()
  })

  it('requires an independent strong signing secret', () => {
    expect(() =>
      issueAgentAccessToken({ subject: 'agent-1', scopes: [] }, {
        AIPMS_AGENT_SIGNING_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32/)
  })
})
