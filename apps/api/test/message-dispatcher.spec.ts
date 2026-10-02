import { randomUUID } from 'node:crypto'
import { db, Prisma } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { MessageDispatcherService } from '../src/messaging/message-dispatcher.service'
import { MessagingService } from '../src/messaging/messaging.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

const ids: string[] = []
const vendorIds: string[] = []
const poIds: string[] = []
const receiptIds: string[] = []
const recipient = `dispatch-${randomUUID()}@vendor.example`

afterAll(async () => {
  await db.domainEvent.deleteMany({
    where: { entityId: { in: ids }, entityType: 'Message' },
  })
  await db.message.deleteMany({ where: { id: { in: ids } } })
  await db.receipt.deleteMany({ where: { id: { in: receiptIds } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: poIds } } })
  await db.invoice.deleteMany({ where: { vendorId: { in: vendorIds } } })
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
  const invoice = await db.invoice.create({
    data: {
      vendorId: vendor.id,
      number: `INV-${randomUUID()}`,
      amountMinor: 1000,
    },
  })
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
                templateParams: { invoiceNumber: invoice.number },
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
    invoice,
    service,
    sends,
    stage,
    dispatcher: new MessageDispatcherService(service),
  }
}

describe('staged message crash recovery (PostgreSQL)', () => {
  it('retains unsafe legacy auto rows without contacting the provider', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.message.update({
      where: { id },
      data: { templateVersion: null, templateParams: Prisma.DbNull },
    })
    await f.dispatcher.poll()
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'failed', failedReason: expect.stringContaining('provenance') },
    )
  })

  it('refuses an invoice removed between staging and dispatch', async () => {
    const f = await fixture()
    const id = await f.stage()
    await db.invoice.delete({ where: { id: f.invoice.id } })
    await f.service.dispatchIfQueued(id)
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'failed', failedReason: expect.stringContaining('Invoice') },
    )
  })

  it('refuses a PO status changed after composition without rewriting the message', async () => {
    const f = await fixture()
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `PO-${randomUUID()}`,
        vendorId: f.vendor.id,
        status: 'confirmed',
        totalMinor: 1000,
        issuedBy: 'fixture',
      },
    })
    poIds.push(po.id)
    const staged = await db.$transaction((tx) =>
      f.service.submit(
        {
          vendorId: f.vendor.id,
          recipient,
          templateId: 'po_status',
          templateParams: { poNumber: po.poNumber, status: 'confirmed' },
        },
        tx,
      ),
    )
    const id = (staged.message as { id: string }).id
    ids.push(id)
    await db.purchaseOrder.update({
      where: { id: po.id },
      data: { status: 'cancelled' },
    })
    await f.service.dispatchIfQueued(id)
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      {
        status: 'failed',
        subject: `Purchase order ${po.poNumber}: confirmed`,
        failedReason: expect.stringContaining('canonical'),
      },
    )
  })

  it('refuses a receipt cancelled after staging its acknowledgement', async () => {
    const f = await fixture()
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `PO-${randomUUID()}`,
        vendorId: f.vendor.id,
        status: 'confirmed',
        totalMinor: 1000,
        issuedBy: 'fixture',
      },
    })
    poIds.push(po.id)
    const receipt = await db.receipt.create({
      data: {
        receiptNumber: `R-${randomUUID()}`,
        poId: po.id,
        vendorId: f.vendor.id,
        recordedBy: 'fixture',
        lines: { create: { description: 'Synthetic goods', quantity: 3 } },
      },
    })
    receiptIds.push(receipt.id)
    const staged = await db.$transaction((tx) =>
      f.service.submit(
        {
          vendorId: f.vendor.id,
          recipient,
          templateId: 'delivery_notice',
          templateParams: { receiptId: receipt.id },
        },
        tx,
      ),
    )
    const id = (staged.message as { id: string }).id
    ids.push(id)
    await db.receipt.update({
      where: { id: receipt.id },
      data: { status: 'cancelled' },
    })
    await f.service.dispatchIfQueued(id)
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      {
        status: 'failed',
        failedReason: expect.stringContaining('recorded receipt'),
      },
    )
  })

  it('rolls back the delivery claim on canonical-reader infrastructure failure', async () => {
    const f = await fixture()
    const id = await f.stage()
    const failure = new Error('canonical reader unavailable')
    const client = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction')
          return (
            callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          ) =>
            db.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, field) {
                    if (field === 'invoice')
                      return { findUnique: () => Promise.reject(failure) }
                    return Reflect.get(inner, field)
                  },
                }),
              ),
            )
        return Reflect.get(target, key)
      },
    })
    await expect(f.service.dispatchIfQueued(id, client)).rejects.toBe(failure)
    expect(f.sends).toHaveLength(0)
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'queued', dispatchStartedAt: null },
    )
    // This deliberately still-eligible row must not enter the next test's poll.
    await db.message.delete({ where: { id } })
  })

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
            templateParams: { invoiceNumber: f.invoice.number },
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
