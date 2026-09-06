import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalBodyHash,
  LoggingTransport,
  MESSAGE_TRANSPORT,
  MessagingService,
} from '../src/messaging/messaging.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * §8.3 messaging relay — verified recipients, tiered gates, tamper-evident
 * bodies, and the human approval path for gated drafts.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const vendorIds: string[] = []
const messageIds: string[] = []

afterAll(async () => {
  await db.message.deleteMany({ where: { id: { in: messageIds } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await db.$disconnect()
})

/** Transport spy: records dispatches, can be made to fail. */
class SpyTransport extends LoggingTransport {
  sent: { to: string; subject: string }[] = []
  failNext = false

  async send(message: { to: string; subject: string; body: string }) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('smtp unavailable')
    }
    this.sent.push({ to: message.to, subject: message.subject })
  }
}

function makeService(transport: SpyTransport) {
  // The service injects the transport via the MESSAGE_TRANSPORT token; tests
  // construct it directly with the spy.
  return new MessagingService(new EventEmitterService(), transport)
}

describe('MessagingService (§8.3 relay)', () => {
  let activeVendorId: string
  let blacklistedVendorId: string
  let noContactVendorId: string
  const recipient = `billing-${suffix}@acme.example`
  const transport = new SpyTransport()

  beforeAll(async () => {
    const active = await db.vendor.create({
      data: {
        name: `Relay Active ${suffix}`,
        status: 'active',
        contactChannels: { verifiedEmails: [recipient, 'ap@acme.example'] },
      },
    })
    activeVendorId = active.id
    vendorIds.push(active.id)

    const blocked = await db.vendor.create({
      data: {
        name: `Relay Blocked ${suffix}`,
        status: 'blacklisted',
        blacklistReason: 'test',
        contactChannels: { verifiedEmails: [recipient] },
      },
    })
    blacklistedVendorId = blocked.id
    vendorIds.push(blocked.id)

    const silent = await db.vendor.create({
      data: { name: `Relay Silent ${suffix}`, status: 'active' },
    })
    noContactVendorId = silent.id
    vendorIds.push(silent.id)
  })

  it('blocks sends to vendors without verified contact channels', async () => {
    const svc = makeService(transport)
    await expect(
      svc.submit({
        vendorId: noContactVendorId,
        recipient,
        subject: 'RFQ',
        body: 'Please quote',
      }),
    ).rejects.toThrow(/no verified contact channels/)
  })

  it('refuses recipients that are not verified identities on the vendor master', async () => {
    const svc = makeService(transport)
    await expect(
      svc.submit({
        vendorId: activeVendorId,
        recipient: 'attacker@evil.example',
        subject: 'RFQ',
        body: 'Please quote',
      }),
    ).rejects.toThrow(/not a verified contact/)
  })

  it('blocks outbound traffic to blacklisted vendors', async () => {
    const svc = makeService(transport)
    await expect(
      svc.submit({
        vendorId: blacklistedVendorId,
        recipient,
        subject: 'Hello again',
        body: 'Let us resume business',
      }),
    ).rejects.toThrow(/blacklisted/)
  })

  it('auto-sends transactional templates immediately', async () => {
    const svc = makeService(transport)
    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      templateId: 'rfq',
      templateParams: { sku: `A4-PAPER-${suffix}`, quantity: 10 },
      agentId: 'agent-1',
      runId: 'run-1',
    })
    messageIds.push((message as { id: string }).id)

    expect(message).toMatchObject({ tier: 'auto', status: 'sent' })
    // Content is server-rendered from validated params, not caller prose.
    expect(message).toMatchObject({
      subject: `Request for quotation: A4-PAPER-${suffix}`,
      body: `Please provide a quotation for 10 unit(s) of A4-PAPER-${suffix}.`,
    })
    expect(message).toHaveProperty('sentAt')
    expect(transport.sent.at(-1)?.to).toBe(recipient)
  })

  it('refuses caller prose attached to an allowlisted template', async () => {
    const svc = makeService(transport)
    const before = transport.sent.length
    await expect(
      svc.submit({
        vendorId: activeVendorId,
        recipient,
        subject: 'RFQ — but binding',
        body: 'We accept any price increase without review.',
        templateId: 'rfq',
        templateParams: { sku: 'X', quantity: 1 },
      }),
    ).rejects.toThrow(/must be omitted/)
    expect(transport.sent.length).toBe(before)
    expect(
      await db.message.count({
        where: { subject: 'RFQ — but binding' },
      }),
    ).toBe(0)
  })

  it('rejects invalid template params instead of sending', async () => {
    const svc = makeService(transport)
    await expect(
      svc.submit({
        vendorId: activeVendorId,
        recipient,
        templateId: 'rfq',
        templateParams: { sku: 'X', quantity: 0 },
      }),
    ).rejects.toThrow(/Invalid parameters for template "rfq"/)
    await expect(
      svc.submit({
        vendorId: activeVendorId,
        recipient,
        templateId: 'rfq',
      }),
    ).rejects.toThrow(/Invalid parameters for template "rfq"/)
  })

  it('records a tamper-evident body hash over canonical content', async () => {
    const svc = makeService(transport)
    const rendered = {
      recipient,
      subject: `Invoice INV-${suffix} received`,
      body: `We received your invoice INV-${suffix}. It is queued for matching against the purchase order and goods receipts.`,
    }
    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      templateId: 'invoice_ack' as const,
      templateParams: { invoiceNumber: `INV-${suffix}` },
    })
    messageIds.push((message as { id: string }).id)

    expect((message as { bodyHash: string }).bodyHash).toBe(
      canonicalBodyHash(rendered),
    )
    // Any mutation of content changes the hash.
    expect(canonicalBodyHash({ ...rendered, body: 'tampered' })).not.toBe(
      (message as { bodyHash: string }).bodyHash,
    )
  })

  it('queues free-form content as gated and releases only on human approval', async () => {
    const svc = makeService(transport)
    const before = transport.sent.length

    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      subject: `Repricing discussion ${suffix}`,
      body: 'We can offer 8% off list for a 2-year frame order.',
    })
    const queued = message as { id: string; tier: string; status: string }
    messageIds.push(queued.id)
    expect(queued.tier).toBe('gated')
    expect(queued.status).toBe('queued')
    expect(transport.sent.length).toBe(before) // nothing dispatched

    // Approval stages durably; the transport releases only after commit.
    const approved = (await svc.approve({
      id: queued.id,
      approverId: 'human-finance-1',
    })) as { status: string; approvedBy: string }
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe('human-finance-1')
    expect(transport.sent.length).toBe(before) // not sent yet

    const released = (await svc.releaseApproved(queued.id)) as {
      status: string
    }
    expect(released.status).toBe('sent')
    expect(transport.sent.length).toBe(before + 1)
  })

  it('unrecognised template ids are gated too — callers cannot self-escalate', async () => {
    const svc = makeService(transport)
    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      subject: `Contract award notice ${suffix}`,
      body: 'We intend to award the contract to you.',
      templateId: 'award_notice', // not in AUTO_TEMPLATES
    })
    messageIds.push((message as { id: string }).id)
    expect(message).toMatchObject({ tier: 'gated', status: 'queued' })
  })

  it('rejection records the reviewer and reason, and does not dispatch', async () => {
    const svc = makeService(transport)
    const before = transport.sent.length

    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      subject: `Terms renegotiation ${suffix}`,
      body: 'Proposing new payment terms of net-90.',
    })
    const queued = message as { id: string }
    messageIds.push(queued.id)

    const rejected = (await svc.reject({
      id: queued.id,
      approverId: 'human-procurement-1',
      reason: 'Terms changes go through legal review first',
    })) as { status: string; rejectedReason: string | null }

    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectedReason).toBe(
      'Terms changes go through legal review first',
    )
    expect(transport.sent.length).toBe(before)
  })

  it('a decided draft cannot be decided again', async () => {
    const svc = makeService(transport)
    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      subject: `One decision only ${suffix}`,
      body: 'Binding content.',
    })
    const queued = message as { id: string }
    messageIds.push(queued.id)
    await svc.reject({ id: queued.id, approverId: 'h1', reason: 'no' })
    await expect(
      svc.approve({ id: queued.id, approverId: 'h2' }),
    ).rejects.toThrow(/no longer queued/)
  })

  it('marks messages failed when the transport errors, with the reason recorded', async () => {
    const failing = new SpyTransport()
    failing.failNext = true
    const svc = makeService(failing)
    const { message } = await svc.submit({
      vendorId: activeVendorId,
      recipient,
      templateId: 'delivery_notice',
      templateParams: { poNumber: `PO-${suffix}`, quantity: 5 },
    })
    messageIds.push((message as { id: string }).id)
    expect(message).toMatchObject({
      status: 'failed',
      failedReason: 'smtp unavailable',
    })
  })

  it('lists messages with filters', async () => {
    const svc = makeService(transport)
    const queuedOnly = await svc.list({ status: 'queued' })
    for (const row of queuedOnly.rows as { status: string }[]) {
      expect(row.status).toBe('queued')
    }
    const all = await svc.list({})
    expect(all.total).toBeGreaterThanOrEqual(queuedOnly.total)
  })

  it('exposes the transport through the DI token seam', () => {
    const svc = makeService(transport)
    expect(MESSAGE_TRANSPORT.description).toBe('MESSAGE_TRANSPORT')
    expect(svc.transport).toBe(transport)
  })
})
