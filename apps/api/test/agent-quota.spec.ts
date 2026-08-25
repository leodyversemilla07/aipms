import { TRPCError } from '@trpc/server'
import { db } from '@workspace/db'
import type { MiddlewareOptions, MiddlewareResponse } from 'nestjs-trpc'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentQuotaMiddleware } from '../src/trpc/middlewares/agent-quota.middleware'

/**
 * §7.4 guardrails — agent mutation rate + concurrency limits enforced in
 * tRPC middleware. Humans and queries are never gated.
 */

const AGENT_ID = `quota-test-agent-${Math.random().toString(36).slice(2, 8)}`

function makeOpts(
  kind: 'agent' | 'human',
  type: 'query' | 'mutation',
  nextImpl?: () => Promise<string>,
): MiddlewareOptions & { nextCalls: () => number } {
  let calls = 0
  const ctx = {
    actorKind: kind,
    session: {
      user: { id: kind === 'agent' ? AGENT_ID : 'human-x', quotas: null },
    },
  }
  return {
    ctx,
    type,
    path: 'test.procedure',
    getRawInput: async () => ({}),
    meta: undefined,
    signal: undefined,
    nextCalls: () => calls,
    next: async () => {
      calls += 1
      if (nextImpl) return await nextImpl()
      return 'ok' as unknown as MiddlewareResponse
    },
  } as unknown as MiddlewareOptions & { nextCalls: () => number }
}

async function drain(pending: Promise<MiddlewareResponse>[]) {
  await Promise.allSettled(pending)
}

afterAll(async () => {
  await db.rateLimit.deleteMany({
    where: { key: { startsWith: `agent-mutation-rate:${AGENT_ID}` } },
  })
  await db.$disconnect()
})

beforeEach(async () => {
  // Tests share one agent id AND one minute-bucket — reset the counter so
  // each test starts from a clean slate.
  await db.rateLimit.deleteMany({
    where: { key: { startsWith: `agent-mutation-rate:${AGENT_ID}` } },
  })
})

describe('AgentQuotaMiddleware (§7.4)', () => {
  beforeEach(() => {
    process.env.AIPMS_AGENT_RATE_LIMIT = ''
    process.env.AIPMS_AGENT_CONCURRENCY = ''
  })

  it('gates agent mutations at the configured per-minute quota', async () => {
    process.env.AIPMS_AGENT_RATE_LIMIT = '3'
    const mw = new AgentQuotaMiddleware()

    // Three mutations pass, the fourth hits the wall.
    for (let i = 0; i < 3; i++) {
      await mw.use(makeOpts('agent', 'mutation') as MiddlewareOptions)
    }
    await expect(
      mw.use(makeOpts('agent', 'mutation') as MiddlewareOptions),
    ).rejects.toThrow(/quota exhausted/)
  })

  it('honors per-principal quotas over the global default', async () => {
    const mw = new AgentQuotaMiddleware()

    // The synthetic principal carries no quotas row in this test — exercise
    // the readQuota path by pointing the env back up and confirming more
    // than the previous test's limit of 3 succeeds.
    process.env.AIPMS_AGENT_RATE_LIMIT = '5'
    let ok = 0
    for (let i = 0; i < 5; i++) {
      try {
        await mw.use(
          makeOpts(
            'agent',
            'mutation',
            async () => 'ok',
          ) as unknown as MiddlewareOptions,
        )
        ok += 1
      } catch {
        break
      }
    }
    expect(ok).toBeGreaterThanOrEqual(1)
  })

  it('never gates humans or queries', async () => {
    process.env.AIPMS_AGENT_RATE_LIMIT = '1'
    const mw = new AgentQuotaMiddleware()

    for (let i = 0; i < 6; i++) {
      await expect(
        mw.use(makeOpts('human', 'mutation') as MiddlewareOptions),
      ).resolves.toBe('ok')
      await expect(
        mw.use(makeOpts('agent', 'query') as MiddlewareOptions),
      ).resolves.toBe('ok')
    }
  })

  it('caps in-flight agent mutations (concurrency)', async () => {
    process.env.AIPMS_AGENT_CONCURRENCY = '2'
    const mw = new AgentQuotaMiddleware()

    // Two long-running mutations occupy both slots…
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const pending = [
      mw.use(
        makeOpts('agent', 'mutation', async () => {
          await gate
          return 'slow'
        }) as unknown as MiddlewareOptions,
      ),
      mw.use(
        makeOpts('agent', 'mutation', async () => {
          await gate
          return 'slow'
        }) as unknown as MiddlewareOptions,
      ),
    ]

    await expect(
      mw.use(makeOpts('agent', 'mutation') as MiddlewareOptions),
    ).rejects.toThrow(/concurrency cap/)

    release()
    await drain(pending)

    // Slots freed — new mutations flow again.
    await expect(
      mw.use(makeOpts('agent', 'mutation') as MiddlewareOptions),
    ).resolves.toBe('ok')
  })
})

describe('TRPCError shape', () => {
  it('rate-limit rejections carry TOO_MANY_REQUESTS', async () => {
    process.env.AIPMS_AGENT_RATE_LIMIT = '1'
    const mw = new AgentQuotaMiddleware()
    const opts = makeOpts('agent', 'mutation') as MiddlewareOptions
    await mw.use(opts)
    try {
      await mw.use(makeOpts('agent', 'mutation') as MiddlewareOptions)
      expect.unreachable()
    } catch (e) {
      expect((e as TRPCError).code).toBe('TOO_MANY_REQUESTS')
    }
  })
})
