import { db } from '@workspace/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationLeaseService } from '../src/shared/automation/automation-lease.service'

/**
 * The lease guards a drain against a second replica. The guarded work reads
 * its admission counters through the shared connection, so the lease must not
 * hold a transaction open around it: the SQLite driver adapter serialises
 * every statement on a connection behind the open transaction, and the work
 * would wait for the lease that is guarding it.
 */
describe('automation lease', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('lets the guarded work read through the shared connection', async () => {
    // A short lease timeout keeps a regression fast instead of hanging.
    vi.stubEnv('AUTOMATION_LEASE_TIMEOUT_MS', '2000')
    const lease = new AutomationLeaseService()
    const result = await lease.runExclusive('lease-probe', async () => {
      const row = await db.rateLimit.findFirst({ select: { key: true } })
      return row?.key ?? null
    })
    expect(result).toMatchObject({ acquired: true })
  })

  it('returns the guarded result', async () => {
    const lease = new AutomationLeaseService()
    const result = await lease.runExclusive('lease-probe', async () => 'done')
    expect(result).toEqual({ acquired: true, value: 'done' })
  })
})
