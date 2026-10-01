import './no-database'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { db } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { stagedMessageWhere } from '../../src/messaging/message-dispatch-policy'
import {
  canonicalBodyHash,
  MessagingService,
} from '../../src/messaging/messaging.service'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'
import { matches } from './fixtures/query'

function fixture(overrides: Record<string, unknown> = {}) {
  const content = {
    recipient: 'verified@vendor.example',
    subject: 'Invoice received',
    body: 'Transactional acknowledgement',
  }
  const message: Record<string, unknown> = {
    id: 'message-1',
    vendorId: 'vendor-1',
    ...content,
    bodyHash: canonicalBodyHash(content),
    tier: 'auto',
    status: 'queued',
    approvedBy: null,
    approvedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    transportMessageId: null,
    deliveryResolution: null,
    deliveryResolvedAt: null,
    deliveryResolvedBy: null,
    deliveryResolutionEvidence: null,
    ...overrides,
  }
  let vendor: Record<string, unknown> | null = {
    id: 'vendor-1',
    status: 'active',
    contactChannels: { verifiedEmails: [content.recipient] },
  }
  const transactionScope = new AsyncLocalStorage<boolean>()
  let tail = Promise.resolve()
  const query = vi.fn().mockResolvedValue([])
  const client = {
    message: {
      findUnique: vi.fn(async () => structuredClone(message)),
      findUniqueOrThrow: vi.fn(async () => structuredClone(message)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (!matches(message, where)) return { count: 0 }
        Object.assign(message, data)
        return { count: 1 }
      }),
    },
    vendor: { findUnique: vi.fn(async () => structuredClone(vendor)) },
    $queryRaw: query,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      // Synthetic serialization only. Real row locks have separate PG tests.
      const next = tail.then(() =>
        transactionScope.run(true, () => callback(client)),
      )
      tail = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    },
  } as unknown as typeof db
  const emit = vi.fn().mockResolvedValue({})
  const send = vi.fn(async () => {
    expect(transactionScope.getStore()).not.toBe(true)
    expect(message.status).toBe('sending')
    return { providerMessageId: 'provider-receipt' }
  })
  const service = new MessagingService(
    { emit } as unknown as EventEmitterService,
    { send },
  )
  return {
    message,
    client,
    service,
    send,
    emit,
    query,
    setVendor(value: typeof vendor) {
      vendor = value
    },
  }
}

describe('durable message claim boundaries (injected clients)', () => {
  it('commits the claim before transport and records a single receipt/event', async () => {
    const f = fixture()
    await expect(
      f.service.dispatchIfQueued('message-1', f.client),
    ).resolves.toMatchObject({
      status: 'sent',
      transportMessageId: 'provider-receipt',
    })
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.emit).toHaveBeenCalledTimes(1)
    expect(f.message.dispatchStartedAt).toBeInstanceOf(Date)
    expect(f.query.mock.calls.map(([sql]) => sql.join('?'))).toEqual([
      'SELECT id FROM "message" WHERE id = ? FOR UPDATE',
      'SELECT id FROM "vendor" WHERE id = ? FOR UPDATE',
    ])
  })

  it('the synthetic serialized claim admits one of two competing callers', async () => {
    const f = fixture()
    await Promise.all([
      f.service.dispatchIfQueued('message-1', f.client),
      f.service.dispatchIfQueued('message-1', f.client),
    ])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.message.status).toBe('sent')
  })

  it('releases only durably reviewed approved drafts', async () => {
    const f = fixture({
      tier: 'gated',
      status: 'approved',
      approvedBy: 'checker',
      approvedAt: new Date(),
    })
    await f.service.releaseApproved('message-1', f.client)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unreviewed gated queue', { tier: 'gated' }],
    ['already sending', { status: 'sending' }],
    ['failed attempt', { status: 'failed' }],
    ['rejected draft', { status: 'rejected' }],
    ['already sent', { status: 'sent' }],
    ['prior attempt timestamp', { dispatchStartedAt: new Date() }],
    ['prior sent timestamp', { sentAt: new Date() }],
    ['prior receipt', { transportMessageId: 'existing-receipt' }],
    [
      'confirmed delivered resolution',
      { deliveryResolution: 'confirmed_sent' },
    ],
    ['unsubstantiated retry', { deliveryResolution: 'confirmed_not_sent' }],
  ])('does not replay %s', async (_name, patch) => {
    const f = fixture(patch)
    expect(matches(f.message, stagedMessageWhere())).toBe(false)
    await f.service.dispatchIfQueued('message-1', f.client)
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    { approvedBy: null, approvedAt: new Date() },
    { approvedBy: 'checker', approvedAt: null },
  ])('does not deliver incomplete approval metadata %j', async (patch) => {
    const f = fixture({ tier: 'gated', status: 'approved', ...patch })
    await f.service.releaseApproved('message-1', f.client)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('accepts a durably evidenced non-delivery resolution without replaying it twice', async () => {
    const f = fixture({
      deliveryResolution: 'confirmed_not_sent',
      deliveryResolutionEvidence: 'Provider confirms rejection',
      deliveryResolvedBy: 'independent-finance',
      deliveryResolvedAt: new Date(),
    })
    await f.service.dispatchIfQueued('message-1', f.client)
    await f.service.dispatchIfQueued('message-1', f.client)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it.each(['recipient', 'subject', 'body'])(
    'refuses changed %s before external delivery',
    async (field) => {
      const f = fixture({ [field]: 'changed content' })
      await f.service.dispatchIfQueued('message-1', f.client)
      expect(f.send).not.toHaveBeenCalled()
      expect(f.message).toMatchObject({
        status: 'failed',
        failedReason: expect.stringContaining('hash'),
      })
    },
  )

  it.each([
    ['missing vendor', null],
    [
      'blacklisted vendor',
      {
        id: 'vendor-1',
        status: 'blacklisted',
        contactChannels: { verifiedEmails: ['verified@vendor.example'] },
      },
    ],
    [
      'revoked recipient',
      {
        id: 'vendor-1',
        status: 'active',
        contactChannels: { verifiedEmails: [] },
      },
    ],
  ])('refuses %s at delivery time', async (_name, vendor) => {
    const f = fixture()
    f.setVendor(vendor)
    await f.service.dispatchIfQueued('message-1', f.client)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.message.status).toBe('failed')
  })

  it('retains a failed claim on ambiguous transport errors and never retries it', async () => {
    const f = fixture()
    f.send.mockRejectedValueOnce(new Error('connection reset after acceptance'))
    await f.service.dispatchIfQueued('message-1', f.client)
    await f.service.dispatchIfQueued('message-1', f.client)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.message).toMatchObject({
      status: 'failed',
      failedReason: 'connection reset after acceptance',
    })
    expect(f.message.dispatchStartedAt).toBeInstanceOf(Date)
  })
})
