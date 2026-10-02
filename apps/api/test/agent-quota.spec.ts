import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { db } from '@workspace/db'
import type { MiddlewareOptions } from 'nestjs-trpc'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { AgentQuotaService } from '../src/shared/agent-quota/agent-quota.service'
import { AgentQuotaMiddleware } from '../src/trpc/middlewares/agent-quota.middleware'

const id = `quota-${randomUUID()}`
const actor = { id, kind: 'agent' as const }
const quotas = () => new AgentQuotaService()
const middleware = (service = quotas()) => new AgentQuotaMiddleware(service)
function options(
  kind: 'agent' | 'human' = 'agent',
  type: 'mutation' | 'query' = 'mutation',
  task = async () => 'ok',
) {
  return {
    ctx: { actorKind: kind, session: { user: { id } } },
    type,
    path: 'test.mutate',
    next: task,
  } as unknown as MiddlewareOptions
}
const cleanup = async () => {
  await db.rateLimit.deleteMany({
    where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
  })
  await db.user.deleteMany({ where: { id } })
}
beforeEach(async () => {
  vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '60')
  vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '4')
  vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
  await cleanup()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

describe('shared quota accounting (PostgreSQL)', () => {
  it('tRPC reports TOO_MANY_REQUESTS after the configured rate', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '3')
    const adapter = middleware()
    for (let i = 0; i < 3; i++) await adapter.use(options())
    await expect(adapter.use(options())).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })

  it('reads actual per-principal quotas from User, not caller session fields', async () => {
    await db.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        name: id,
        kind: 'agent',
        quotas: { mutationsPerMinute: 1 },
      },
    })
    const adapter = middleware()
    const forged = options()
    forged.ctx = {
      actorKind: 'agent',
      session: { user: { id, quotas: { mutationsPerMinute: 999999 } } },
    }
    await adapter.use(forged)
    await expect(adapter.use(forged)).rejects.toBeInstanceOf(TRPCError)
  })

  it('all adapters/command sources share persistent counters across service instances', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '2')
    await middleware().use(options())
    await quotas().run(actor, 'agent.process', async () => 'event-wake')
    await expect(
      quotas().run(actor, 'agent.batch', async () => 'REST'),
    ).rejects.toThrow(/quota exhausted/)
  })

  it('parallel replicas atomically increment the same first-hit bucket', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '3')
    vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '16')
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        quotas().run(actor, 'agent.process', async () => 'ok'),
      ),
    )
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    const counter = await db.rateLimit.findFirstOrThrow({
      where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
    })
    expect(counter.count).toBe(8)
  })

  it('same-operation middleware/command nesting consumes one admission', async () => {
    const service = quotas()
    const adapter = middleware(service)
    const input = options('agent', 'mutation', () =>
      service.run(actor, 'test.mutate', async () => 'ok'),
    )
    expect(await adapter.use(input)).toBe('ok')
    const counter = await db.rateLimit.findFirstOrThrow({
      where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
    })
    expect(counter.count).toBe(1)
  })

  it('distinct batch documents consume rate while reusing the one concurrency slot', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '2')
    vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '1')
    const service = quotas()
    await service.run(actor, 'agent.batch', async () => {
      await service.run(actor, 'agent.process', async () => 'first')
      await expect(
        service.run(actor, 'agent.process', async () => 'second'),
      ).rejects.toThrow(/quota exhausted/)
    })
  })

  it('human mutations and agent queries do not consume machine budgets', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '1')
    const adapter = middleware()
    for (let i = 0; i < 4; i++) {
      await adapter.use(options('human'))
      await adapter.use(options('agent', 'query'))
    }
    expect(
      await db.rateLimit.count({
        where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
      }),
    ).toBe(0)
  })

  it('shared adapters synchronously reserve slots and release them after errors', async () => {
    vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '1')
    const service = quotas()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = middleware(service).use(
      options('agent', 'mutation', async () => {
        entered()
        await gate
        throw new Error('domain failure')
      }),
    )
    await started
    await expect(
      service.run(actor, 'agent.process', async () => 'command'),
    ).rejects.toThrow(/concurrency cap/)
    release()
    await expect(first).rejects.toThrow('domain failure')
    expect(await middleware(service).use(options())).toBe('ok')
  })
})
