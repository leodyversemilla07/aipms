import './no-database'
import { ServiceUnavailableException } from '@nestjs/common'
import type { db, Prisma } from '@workspace/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCommandService } from '../../src/agent/agent-command.service'
import {
  AgentQuotaExceededError,
  AgentQuotaService,
} from '../../src/shared/agent-quota/agent-quota.service'

const actor = { id: 'unit-agent', kind: 'agent' as const }
function fixture() {
  let user: unknown = null
  const counts = new Map<string, number>()
  const client = {
    user: { findUnique: vi.fn(async () => user) },
    rateLimit: {
      upsert: vi.fn(async ({ where }) => {
        const count = (counts.get(where.key) ?? 0) + 1
        counts.set(where.key, count)
        return { count }
      }),
    },
  } as unknown as Pick<typeof db, 'user' | 'rateLimit'>
  const service = new AgentQuotaService()
  return {
    service,
    client,
    counts,
    setUser(value: unknown) {
      user = value
    },
    run: (operation: string, task = async () => 'ok') =>
      service.run(actor, operation, task, client),
  }
}
beforeEach(() => {
  vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '2')
  vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '1')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('machine admission configuration (injected clients)', () => {
  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '2147483648'])(
    'refuses invalid rate %j before client/domain access',
    async (value) => {
      vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', value)
      const f = fixture()
      const task = vi.fn()
      await expect(
        f.service.run(actor, 'mutate', task, f.client),
      ).rejects.toBeInstanceOf(ServiceUnavailableException)
      expect(f.client.user.findUnique).not.toHaveBeenCalled()
      expect(task).not.toHaveBeenCalled()
    },
  )
  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '2147483648'])(
    'refuses invalid concurrency %j at startup',
    (value) => {
      vi.stubEnv('AIPMS_AGENT_CONCURRENCY', value)
      expect(() => fixture().service.onModuleInit()).toThrow(
        ServiceUnavailableException,
      )
    },
  )
  it.each([0, -1, 1.5, '1000', null, 'Infinity'])(
    'refuses malformed stored quotas %j rather than applying permissive defaults',
    async (value) => {
      const f = fixture()
      f.setUser({ kind: 'agent', quotas: { mutationsPerMinute: value } })
      await expect(f.run('mutate')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      )
      expect(f.client.rateLimit.upsert).not.toHaveBeenCalled()
    },
  )
  it('refuses a human-row collision for a machine principal', async () => {
    const f = fixture()
    f.setUser({ kind: 'human', quotas: null })
    await expect(f.run('mutate')).rejects.toThrow(/non-agent/)
  })
  it('server-owned quotas override environment, never actor/source metadata', async () => {
    const f = fixture()
    f.setUser({ kind: 'agent', quotas: { mutationsPerMinute: 1 } })
    const forged = {
      ...actor,
      source: 'trpc',
      quotas: { mutationsPerMinute: 999999 },
    }
    await f.service.run(forged, 'mutate', async () => 'ok', f.client)
    await expect(
      f.service.run(forged, 'mutate', async () => 'ok', f.client),
    ).rejects.toBeInstanceOf(AgentQuotaExceededError)
  })
  it('human tasks are untouched and cannot accidentally access the default DB', async () => {
    expect(
      await fixture().service.run(
        { id: 'human', kind: 'human' },
        'mutate',
        async () => 'human',
      ),
    ).toBe('human')
  })
})

describe('shared nesting and slot lifetime (injected clients)', () => {
  it('reuses same-operation admission but bills sequential child operations', async () => {
    const f = fixture()
    await f.run('batch', async () => {
      await f.run('batch')
      await f.run('document')
      await expect(f.run('document')).rejects.toThrow(/quota exhausted/)
      return 'partial'
    })
    expect([...f.counts.values()]).toEqual([3])
  })
  it('actor source does not provide a free quota bypass without internal context', async () => {
    const f = fixture()
    const forged = { ...actor, source: 'trpc' }
    for (let i = 0; i < 2; i++)
      await f.service.run(forged, 'mutate', async () => 'ok', f.client)
    await expect(
      f.service.run(forged, 'mutate', async () => 'ok', f.client),
    ).rejects.toThrow(/quota exhausted/)
  })
  it('reserves before awaits and releases after domain failure', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = f.run('slow', async () => {
      await gate
      throw new Error('domain failed')
    })
    await expect(f.run('other')).rejects.toThrow(/concurrency cap/)
    release()
    await expect(first).rejects.toThrow('domain failed')
    expect(await f.run('other')).toBe('ok')
  })
  it('infrastructure errors fail closed and free the reserved slot', async () => {
    const f = fixture()
    const failure = new Error('counter unavailable')
    vi.mocked(f.client.rateLimit.upsert).mockRejectedValueOnce(failure)
    const task = vi.fn()
    await expect(f.service.run(actor, 'mutate', task, f.client)).rejects.toBe(
      failure,
    )
    expect(task).not.toHaveBeenCalled()
    expect(await f.run('mutate')).toBe('ok')
  })
  it('detached callbacks cannot reuse completed parent admission', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '1')
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let detached!: Promise<unknown>
    await f.run('same', async () => {
      detached = gate.then(() => f.run('same'))
      return 'done'
    })
    release()
    await expect(detached).rejects.toThrow(/quota exhausted/)
  })
  it('nested different principals need independent admission', async () => {
    const f = fixture()
    await f.run('outer', () =>
      f.service.run(
        { id: 'other', kind: 'agent' },
        'outer',
        async () => 'other',
        f.client,
      ),
    )
    expect(f.counts.size).toBe(2)
  })
})

describe('command entry points with a shared quota service', () => {
  function commandFixture() {
    const f = fixture()
    const classifyAndRegister = vi.fn(async () => ({
      doc: { status: 'extracted' },
      invoice: { id: 'invoice' },
      match: null,
    }))
    const record = vi.fn()
    const quotaAdapter = {
      run: <T>(
        principal: typeof actor,
        operation: string,
        task: () => Promise<T>,
      ) => f.service.run(principal, operation, task, f.client),
    } as unknown as AgentQuotaService
    const commands = new AgentCommandService(
      { classifyAndRegister } as never,
      {} as never,
      { record } as never,
      quotaAdapter,
    )
    return { ...f, commands, classifyAndRegister, record }
  }
  it.each(['service-api', 'scheduler', 'event-wake', 'trpc'] as const)(
    'charges direct %s commands and refuses over-budget business work',
    async (source) => {
      vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '1')
      const f = commandFixture()
      const authorized = { ...actor, source, scopes: ['invoice.ingest'] }
      await f.commands.processDocument(
        'doc',
        authorized,
        {} as Prisma.TransactionClient,
      )
      await expect(
        f.commands.processDocument(
          'doc2',
          authorized,
          {} as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(/quota exhausted/)
      expect(f.classifyAndRegister).toHaveBeenCalledTimes(1)
    },
  )
  it('checks capability before reserving or charging quota', async () => {
    const f = commandFixture()
    await expect(
      f.commands.processDocument(
        'doc',
        { ...actor, source: 'scheduler', scopes: [] },
        {} as Prisma.TransactionClient,
      ),
    ).rejects.toThrow(/scope/)
    expect(f.client.rateLimit.upsert).not.toHaveBeenCalled()
    expect(f.classifyAndRegister).not.toHaveBeenCalled()
  })
})
