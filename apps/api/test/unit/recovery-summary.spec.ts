import './no-database'
import type { db } from '@workspace/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRecoverySummary } from '../../src/shared/operations/recovery-summary'
import { matches } from './fixtures/query'

const now = new Date('2026-10-01T10:00:00.000Z')
const old = new Date(now.getTime() - 20 * 60 * 1000)
const fresh = new Date(now.getTime() - 60 * 1000)

function fixture(
  messages: Record<string, unknown>[] = [],
  exports: Record<string, unknown>[] = [],
) {
  const emptyCount = vi.fn().mockResolvedValue(0)
  const messageCount = vi.fn(
    async ({ where }) => messages.filter((row) => matches(row, where)).length,
  )
  const exportCount = vi.fn(
    async ({ where }) => exports.filter((row) => matches(row, where)).length,
  )
  const client = {
    domainEvent: { count: emptyCount },
    agentRun: { count: emptyCount },
    message: { count: messageCount },
    erpJournalExport: { count: exportCount },
  } as unknown as typeof db
  return { client, messageCount, exportCount }
}

describe('external dispatch recovery gauges (injected records)', () => {
  afterEach(() => vi.useRealTimers())

  it('alerts on aged staged rows but not drafts awaiting human approval', async () => {
    vi.useFakeTimers({ now })
    const f = fixture([
      { tier: 'auto', status: 'queued', updatedAt: old },
      // Inconsistent staged history is visible even though not auto-replayable.
      {
        tier: 'auto',
        status: 'queued',
        updatedAt: old,
        dispatchStartedAt: old,
      },
      { tier: 'gated', status: 'approved', updatedAt: old },
      { tier: 'gated', status: 'queued', updatedAt: old },
      { tier: 'auto', status: 'queued', updatedAt: fresh },
      { tier: 'gated', status: 'approved', updatedAt: fresh },
    ])
    expect(await getRecoverySummary(f.client)).toMatchObject({
      staleStagedMessages: 3,
      staleSendingMessages: 0,
      failedMessages: 0,
    })
  })

  it('reports stale and missing-timestamp sending rows without changing them', async () => {
    vi.useFakeTimers({ now })
    const rows = [
      { status: 'sending', dispatchStartedAt: old },
      { status: 'sending', dispatchStartedAt: null },
      { status: 'sending', dispatchStartedAt: fresh },
      { status: 'failed', dispatchStartedAt: old },
      { status: 'sent', dispatchStartedAt: old },
    ]
    const before = structuredClone(rows)
    const f = fixture(rows)
    expect(await getRecoverySummary(f.client)).toMatchObject({
      staleSendingMessages: 2,
      failedMessages: 1,
    })
    expect(rows).toEqual(before)
  })

  it('counts abandoned QBO claims even without a recorded dispatch failure', async () => {
    vi.useFakeTimers({ now })
    const base = {
      status: 'exported',
      dispatchClaimId: 'claim',
      dispatchFailure: null,
      dispatchResolvedAt: null,
      dispatchStartedAt: old,
    }
    const f = fixture(
      [],
      [
        base,
        { ...base, dispatchStartedAt: null },
        {
          ...base,
          dispatchStartedAt: fresh,
          dispatchFailure: 'connection reset',
        },
        { ...base, dispatchStartedAt: fresh },
        { ...base, dispatchClaimId: null },
        { ...base, dispatchResolvedAt: fresh },
        { ...base, status: 'posted' },
      ],
    )
    expect(await getRecoverySummary(f.client)).toMatchObject({
      ambiguousErpDispatches: 3,
    })
    expect(f.exportCount.mock.calls[0][0].where).not.toHaveProperty(
      'dispatchFailure',
    )
  })
})
