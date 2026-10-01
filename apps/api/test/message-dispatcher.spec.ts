import { randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { MessageDispatcherService } from '../src/messaging/message-dispatcher.service'
import { MessagingService } from '../src/messaging/messaging.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

const ids: string[] = []
const vendorIds: string[] = []
const recipient = `dispatch-${randomUUID()}@vendor.example`

afterAll(async () => {
  await db.domainEvent.deleteMany({
    where: { entityId: { in: ids }, entityType: 'Message' },
  })
  await db.message.deleteMany({ where: { id: { in: ids } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await db.$disconnect()
})

async function fixture() {
  const vendor = await db.vendor.create({
    data: {
      name: `Dispatcher ${randomUUID()}`,
      status: 'active',
      contactChannels: { verifiedEmails: [recipient] },
    },
  })
  vendorIds.push(vendor.id)
  const sends: string[] = []
  const service = new MessagingService(new EventEmitterService(), {
    send: async ({ id }) => {
      // A separate connection can read sending: the claim has committed.
      const current = await db.message.findUniqueOrThrow({ where: { id } })
      expect(current.status).toBe('sending')
      sends.push(id)
      return { providerMessageId: `probe:${id}` }
    },
  })
  async function stage(gated = false) {
    const result = await db.$transaction((tx) =>
      service.submit(
        {
          vendorId: vendor.id,
          recipient,
          ...(gated
            ? {
                subject: 'Reviewed commercial draft',
                body: 'Binding draft awaiting approval',
              }
            : {
                templateId: 'invoice_ack',
                templateParams: { invoiceNumber: `INV-${randomUUID()}` },
              }),
        },
        tx,
      ),
    )
    const message = result.message as { id: string }
    ids.push(message.id)
    return message.id
  }
  return {
    vendor,
    service,
    sends,
    stage,
    dispatcher: new MessageDispatcherService(service),
  }
}

describe('staged message crash recovery (PostgreSQL)', () => {
  it('recovers committed auto submissions when the caller never releases', async () => {
    const f = await fixture()
    const id = await f.stage()
    expect(f.sends).toHaveLength(0)
    await f.dispatcher.poll()
    expect(f.sends).toEqual([id])
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'sent' },
    )
    await f.dispatcher.poll()
    expect(f.sends).toEqual([id])
  })

  it('recovers committed approvals but leaves unreviewed gated drafts queued', async () => {
    const f = await fixture()
    const approved = await f.stage(true)
    const draft = await f.stage(true)
    await db.$transaction((tx) =>
      f.service.approve({ id: approved, approverId: 'checker' }, tx),
    )
    await f.dispatcher.poll()
    expect(f.sends).toEqual([approved])
    expect(
      await db.message.findUniqueOrThrow({ where: { id: draft } }),
    ).toMatchObject({ status: 'queued' })
  })

  it('two replicas and the caller share an exclusive durable claim', async () => {
    const f = await fixture()
    const id = await f.stage()
    const second = new MessageDispatcherService(f.service)
    await Promise.all([
      f.dispatcher.poll(),
      second.poll(),
      f.service.dispatchIfQueued(id),
    ])
    expect(f.sends).toEqual([id])
    expect(
      await db.domainEvent.count({
        where: { type: 'message.sent', entityId: id },
      }),
    ).toBe(1)
  })

  it('does not observe an uncommitted submission or send a rolled-back row', async () => {
    const f = await fixture()
    const rollback = new Error('rollback staged crash probe')
    await expect(
      db.$transaction(async (tx) => {
        const result = await f.service.submit(
          {
            vendorId: f.vendor.id,
            recipient,
            templateId: 'invoice_ack',
            templateParams: { invoiceNumber: 'UNCOMMITTED' },
          },
          tx,
        )
        const id = (result.message as { id: string }).id
        ids.push(id)
        await f.dispatcher.poll()
        expect(f.sends).not.toContain(id)
        throw rollback
      }),
    ).rejects.toBe(rollback)
    await f.dispatcher.poll()
    expect(f.sends).toHaveLength(0)
  })

  it('does not see an approval until its surrounding transaction commits', async () => {
    const f = await fixture()
    const id = await f.stage(true)
    await db.$transaction(async (tx) => {
      await f.service.approve({ id, approverId: 'checker' }, tx)
      await f.dispatcher.poll()
      expect(f.sends).toHaveLength(0)
    })
    await f.dispatcher.poll()
    expect(f.sends).toEqual([id])
  })

  it.each(['sending', 'failed'] as const)(
    'does not replay stale %s outcomes',
    async (status) => {
      const f = await fixture()
      const id = await f.stage()
      await db.message.update({
        where: { id },
        data: {
          status,
          dispatchStartedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      })
      await f.dispatcher.poll()
      await f.service.dispatchIfQueued(id)
      expect(f.sends).toHaveLength(0)
      expect(
        await db.message.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status })
    },
  )

  it('does not replay staged rows carrying an unresolved prior attempt', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.message.update({
      where: { id },
      data: { dispatchStartedAt: new Date() },
    })
    await f.dispatcher.poll()
    await f.service.dispatchIfQueued(id)
    expect(f.sends).toHaveLength(0)
  })

  it('rechecks recipient verification after staging', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.vendor.update({
      where: { id: f.vendor.id },
      data: { contactChannels: { verifiedEmails: [] } },
    })
    await f.dispatcher.poll()
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'failed', failedReason: expect.stringContaining('verified') },
    )
  })

  it('rechecks blacklist decisions after staging', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.vendor.update({
      where: { id: f.vendor.id },
      data: { status: 'blacklisted' },
    })
    await f.dispatcher.poll()
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      {
        status: 'failed',
        failedReason: expect.stringContaining('blacklisted'),
      },
    )
  })

  it('refuses content tampering before provider contact', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.message.update({
      where: { id },
      data: { body: 'Modified after staging' },
    })
    await f.dispatcher.poll()
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'failed', failedReason: expect.stringContaining('hash') },
    )
  })

  it('recovers a committed non-delivery resolution without a caller release', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.message.update({
      where: { id },
      data: { status: 'failed', dispatchStartedAt: new Date() },
    })
    await db.$transaction((tx) =>
      f.service.resolveFailedDelivery(
        {
          id,
          resolverId: 'independent-finance',
          outcome: 'confirmed_not_sent',
          evidence:
            'Provider case confirms non-delivery and the prior worker is stopped',
        },
        tx,
      ),
    )
    await f.dispatcher.poll()
    expect(f.sends).toEqual([id])
  })
})
