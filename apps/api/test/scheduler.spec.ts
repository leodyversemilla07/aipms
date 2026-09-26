import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentScheduler } from '../src/agent/agent.scheduler'
import type { AgentCommandService } from '../src/agent/agent-command.service'
import type { AutomationLeaseService } from '../src/shared/automation/automation-lease.service'

/**
 * @workspace agent scheduler — drain loop gating + re-entrancy guard.
 * No DB: the authorized command boundary is stubbed.
 */

const leases = {
  runExclusive: async <T>(_name: string, task: () => Promise<T>) => ({
    acquired: true as const,
    value: await task(),
  }),
} as AutomationLeaseService

function stubCommands(
  batchArgs: number[],
  count: { n: number },
): AgentCommandService {
  return {
    processPending: vi.fn(async (limit: number) => {
      batchArgs.push(limit)
      count.n += 1
      return { documents: 0, succeeded: 0, failed: [] }
    }),
  } as unknown as AgentCommandService
}

describe('AgentScheduler (§3 drain loop)', () => {
  const original = process.env.AGENT_AUTORUN
  const batchInvocations: number[] = []
  const count = { n: 0 }

  it('runs a drain pass via tick with the configured batch', async () => {
    process.env.AGENT_AUTORUN = '1'
    process.env.AGENT_BATCH_SIZE = '7'
    const scheduler = new AgentScheduler(
      stubCommands(batchInvocations, count),
      leases,
    )
    await scheduler.tick()
    await scheduler.tick()
    expect(count.n).toBe(2)
    expect(batchInvocations).toEqual([7, 7])
    scheduler.onModuleDestroy()
  })

  it('skips a pass when another replica owns the database lease', async () => {
    process.env.AGENT_AUTORUN = '1'
    const command = stubCommands(batchInvocations, count)
    const scheduler = new AgentScheduler(command, {
      runExclusive: vi.fn(async () => ({ acquired: false as const })),
    } as unknown as AutomationLeaseService)
    const before = count.n
    await scheduler.tick()
    expect(count.n).toBe(before)
    scheduler.onModuleDestroy()
  })

  it('is re-entrancy guarded — overlapping ticks do not double-run', async () => {
    process.env.AGENT_AUTORUN = '1'
    let scheduledCalls = 0
    let gate: (() => void) | null = null
    const agent = {
      processPending: vi.fn(
        () =>
          new Promise<{ documents: number; succeeded: number; failed: [] }>(
            (resolve) => {
              scheduledCalls += 1
              gate = () => resolve({ documents: 1, succeeded: 1, failed: [] })
            },
          ),
      ),
    } as unknown as AgentCommandService
    const scheduler = new AgentScheduler(agent, leases)
    const first = scheduler.tick()
    const second = scheduler.tick() // overlaps — must be skipped
    gate?.()
    await Promise.all([first, second])
    expect(scheduledCalls).toBe(1)
    scheduler.onModuleDestroy()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_AUTORUN
    else process.env.AGENT_AUTORUN = original
    delete process.env.AGENT_BATCH_SIZE
  })
})
