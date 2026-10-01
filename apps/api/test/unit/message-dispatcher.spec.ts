import './no-database'
import { Logger } from '@nestjs/common'
import type { db } from '@workspace/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stagedMessageWhere } from '../../src/messaging/message-dispatch-policy'
import { MessageDispatcherService } from '../../src/messaging/message-dispatcher.service'
import type { MessagingService } from '../../src/messaging/messaging.service'

function fixture() {
  const dispatchIfQueued = vi.fn().mockResolvedValue({})
  const releaseApproved = vi.fn().mockResolvedValue({})
  const dispatcher = new MessageDispatcherService({
    dispatchIfQueued,
    releaseApproved,
  } as unknown as MessagingService)
  const findMany = vi.fn().mockResolvedValue([
    { id: 'auto-1', status: 'queued' },
    { id: 'approved-1', status: 'approved' },
  ])
  const client = { message: { findMany } } as unknown as typeof db
  return { dispatcher, client, findMany, dispatchIfQueued, releaseApproved }
}

describe('staged message dispatcher', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses bounded deterministic candidates and the shared safe claim boundary', async () => {
    const f = fixture()
    await f.dispatcher.poll(f.client)
    expect(f.findMany).toHaveBeenCalledWith({
      where: stagedMessageWhere(),
      select: { id: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 25,
    })
    expect(f.dispatchIfQueued).toHaveBeenCalledWith('auto-1', f.client)
    expect(f.releaseApproved).toHaveBeenCalledWith('approved-1', f.client)
  })

  it('isolates one candidate error and resets its local reentrancy guard', async () => {
    const f = fixture()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    f.dispatchIfQueued.mockRejectedValueOnce(new Error('database disconnected'))
    await f.dispatcher.poll(f.client)
    expect(f.releaseApproved).toHaveBeenCalledTimes(1)
    await f.dispatcher.poll(f.client)
    expect(f.findMany).toHaveBeenCalledTimes(2)
  })

  it('skips an overlapping local pass', async () => {
    const f = fixture()
    let finish!: (value: object) => void
    f.dispatchIfQueued.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = f.dispatcher.poll(f.client)
    await vi.waitFor(() => expect(f.dispatchIfQueued).toHaveBeenCalledTimes(1))
    await f.dispatcher.poll(f.client)
    expect(f.findMany).toHaveBeenCalledTimes(1)
    finish({})
    await first
  })

  it('resets after polling errors without claiming anything', async () => {
    const f = fixture()
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    f.findMany.mockRejectedValueOnce(new Error('database unavailable'))
    await f.dispatcher.poll(f.client)
    expect(f.dispatchIfQueued).not.toHaveBeenCalled()
    await f.dispatcher.poll(f.client)
    expect(f.releaseApproved).toHaveBeenCalledTimes(1)
  })

  it('stops further claims when the module shuts down', async () => {
    const f = fixture()
    f.dispatchIfQueued.mockImplementationOnce(async () => {
      f.dispatcher.onModuleDestroy()
    })
    await f.dispatcher.poll(f.client)
    expect(f.releaseApproved).not.toHaveBeenCalled()
    await f.dispatcher.poll(f.client)
    expect(f.findMany).toHaveBeenCalledTimes(1)
  })

  it.each(['0', undefined])(
    'does not start a timer in tests with setting %s',
    (setting) => {
      const f = fixture()
      vi.useFakeTimers()
      vi.stubEnv('AIPMS_MESSAGING_DISPATCHER_ENABLED', setting)
      vi.stubEnv('NODE_ENV', 'test')
      f.dispatcher.onModuleInit()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('enables a 5-second timer explicitly and clears it on shutdown', () => {
    const f = fixture()
    vi.useFakeTimers()
    vi.stubEnv('AIPMS_MESSAGING_DISPATCHER_ENABLED', '1')
    const poll = vi.spyOn(f.dispatcher, 'poll').mockResolvedValue()
    f.dispatcher.onModuleInit()
    vi.advanceTimersByTime(5000)
    expect(poll).toHaveBeenCalledTimes(1)
    f.dispatcher.onModuleDestroy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects invalid configuration instead of silently sending', () => {
    const f = fixture()
    vi.stubEnv('AIPMS_MESSAGING_DISPATCHER_ENABLED', 'false')
    expect(() => f.dispatcher.onModuleInit()).toThrow(/must be 0 or 1/)
  })
})
