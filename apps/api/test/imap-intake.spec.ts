import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildRawPayload,
  contentHashFor,
  EMAIL_IMAP_CHANNEL,
  matchVendorSender,
  type ParsedMailLike,
} from '../src/intake/imap-message'
import { IntakeService } from '../src/intake/intake.service'
import { IntakeImapService } from '../src/intake/intake-imap.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * §8.2 email intake — IMAP channel. Pure mapping tests run offline; the
 * integration section pushes a raw RFC-822 message through the real parser
 * + intake queue against local Postgres (dedupe + vendor-master matching).
 */

const suffix = Math.random().toString(36).slice(2, 8)
const docIds: string[] = []
const vendorIds: string[] = []

const intakeService = new IntakeService(new EventEmitterService())
const imapService = new IntakeImapService(intakeService)

function mail(overrides: Partial<ParsedMailLike> = {}): ParsedMailLike {
  return {
    messageId: `<msg-${suffix}@supplier.example>`,
    subject: 'Invoice INV-42',
    text: 'Please find attached invoice INV-42.',
    ...overrides,
  }
}

afterAll(async () => {
  await db.intakeDocument.deleteMany({ where: { id: { in: docIds } } })
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await db.$disconnect()
})

describe('imap-message mapping (§8.2, pure)', () => {
  it('builds the raw payload with headers, body, and attachment hashes', () => {
    const raw = buildRawPayload(
      mail({
        attachments: [
          {
            filename: 'inv-42.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('pdf-bytes'),
          },
        ],
      }),
    )
    expect(raw.headers.subject).toBe('Invoice INV-42')
    expect(raw.headers.messageId).toBe(`<msg-${suffix}@supplier.example>`)
    expect(raw.attachments[0].filename).toBe('inv-42.pdf')
    expect(raw.attachments[0].sha256).toHaveLength(64)
    expect(raw.attachments[0].contentBase64).toBe(
      Buffer.from('pdf-bytes').toString('base64'),
    )
  })

  it('caps inlined attachments at the byte limit but keeps their hash', () => {
    const big = Buffer.alloc(3_000_000, 7)
    const raw = buildRawPayload(
      mail({ attachments: [{ filename: 'big.pdf', content: big }] }),
      1_000_000,
    )
    expect(raw.attachments[0].contentBase64).toBeUndefined()
    expect(raw.attachments[0].size).toBe(3_000_000)
    expect(raw.attachments[0].sha256).toHaveLength(64)
  })

  it('hashes by Message-ID when present', () => {
    const first = contentHashFor(mail({ messageId: '<same@x>' }))
    const second = contentHashFor(
      mail({ messageId: '<same@x>', subject: 'different' }),
    )
    expect(first).toBe(second)
    expect(contentHashFor(mail())).not.toBe(first)
  })

  it('falls back to canonical content hash without Message-ID (stable, distinct)', () => {
    const noId = mail({ messageId: false })
    const again = mail({ messageId: undefined })
    expect(contentHashFor(noId)).toBe(contentHashFor(again))
    expect(
      contentHashFor(mail({ messageId: false, subject: 'other' })),
    ).not.toBe(contentHashFor(noId))
  })
})

describe('vendor-master sender matching (§8.2 defensive intake)', () => {
  const vendors = [
    { id: 'v1', email: 'billing@acme.example', contactChannels: {} },
    {
      id: 'v2',
      email: null,
      contactChannels: {
        verifiedEmails: ['AP@globex.example', 'Sales@GLOBEX.example'],
      },
    },
    {
      id: 'v3',
      email: 'other@initech.example',
      contactChannels: { unverified: ['x@y'] },
    },
  ]

  it('matches the primary vendor email case-insensitively', () => {
    expect(matchVendorSender('BILLING@acme.example', vendors)).toBe('v1')
  })

  it('matches verified contact channels case-insensitively', () => {
    expect(matchVendorSender('ap@globex.example', vendors)).toBe('v2')
    expect(matchVendorSender('sales@globex.example', vendors)).toBe('v2')
  })

  it('does not match unverified or unknown senders', () => {
    expect(matchVendorSender('x@y', vendors)).toBeNull()
    expect(matchVendorSender('phishing@attacker.example', vendors)).toBeNull()
    expect(matchVendorSender(null, vendors)).toBeNull()
  })
})

describe('IMAP message ingestion (integration)', () => {
  it('parses raw RFC-822 source, dedupes, and resolves the sender to the vendor master', async () => {
    const vendor = await db.vendor.create({
      data: {
        name: `Acme IMAP ${suffix}`,
        status: 'active',
        email: `ap-${suffix}@acme.example`,
        contactChannels: { verifiedEmails: [`ap-${suffix}@acme.example`] },
      },
    })
    vendorIds.push(vendor.id)

    // Minimal RFC-822 message; mailparser handles the rest.
    const source = Buffer.from(
      [
        `Message-ID: <imap-spec-${suffix}@acme.example>`,
        `From: AP Desk <ap-${suffix}@acme.example>`,
        'To: procurement@aipms.local',
        'Subject: Invoice INV-99',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Total due PHP 12,340.00.',
        '',
      ].join('\r\n'),
    )

    const ingested = await imapService.ingestMessage(source, [vendor])
    expect(ingested).toBe(true)
    const created = await db.intakeDocument.findFirst({
      where: { channel: EMAIL_IMAP_CHANNEL, senderId: vendor.id },
    })
    expect(created).toBeTruthy()
    if (!created) throw new Error('expected intake document to be created')
    docIds.push(created.id)

    // Re-ingesting the same source is an idempotent no-op ([channel, hash]).
    await imapService.ingestMessage(source, [vendor])
    const rows = await db.intakeDocument.findMany({
      where: { channel: EMAIL_IMAP_CHANNEL, senderId: vendor.id },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('new')

    const payload = created.raw as {
      headers: Record<string, string | null>
      textBody?: string
    }
    expect(payload.headers.messageId).toBe(`<imap-spec-${suffix}@acme.example>`)
    expect(payload.headers.from).toBe(`ap-${suffix}@acme.example`)
    expect(payload.headers.subject).toBe('Invoice INV-99')
    expect(payload.textBody).toContain('12,340.00')
  })

  it('queues unknown senders with senderId null instead of dropping them', async () => {
    const source = Buffer.from(
      [
        `Message-ID: <stranger-${suffix}@unknown.example>`,
        'From: Stranger <who@unknown.example>',
        'Subject: unsolicited quote',
        '',
        'hello',
        '',
      ].join('\r\n'),
    )
    await imapService.ingestMessage(source, [])
    const doc = await db.intakeDocument.findFirst({
      where: { channel: EMAIL_IMAP_CHANNEL, senderId: null },
      orderBy: { receivedAt: 'desc' },
    })
    expect(doc).toBeTruthy()
    if (!doc) throw new Error('expected unknown-sender document to be queued')
    docIds.push(doc.id)
  })
})
