import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { db } from '@workspace/db'
import request from 'supertest'
import type { App } from 'supertest/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MessagingRouter } from '../src/messaging/messaging.router'
import {
  LoggingTransport,
  MESSAGE_TRANSPORT,
  MessagingService,
} from '../src/messaging/messaging.service'
import { AuditService } from '../src/shared/audit/audit.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import { TrpcModule } from '../src/trpc/trpc.module'

/**
 * §8.3 template approval boundary over HTTP. A caller must not be able to
 * smuggle binding prose past human review by labelling it with an
 * allowlisted templateId: auto-tier content is rendered server-side from
 * validated params, and anything else stays gated (or is rejected).
 */
describe('Messaging template boundary over HTTP', () => {
  const prefix = `msgtpl-${randomUUID()}`
  const token = `${prefix}-service-token`
  const recipient = `${prefix}@test.aipms`
  const sku = `${prefix}-SKU`
  let poId: string
  let receiptId: string
  let app: INestApplication<App>
  let vendorId: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TrpcModule],
      providers: [
        MessagingRouter,
        MessagingService,
        AuditService,
        IdempotencyService,
        EventEmitterService,
        { provide: MESSAGE_TRANSPORT, useClass: LoggingTransport },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    await app.init()

    const vendor = await db.vendor.create({
      data: {
        name: `${prefix}-vendor`,
        status: 'active',
        contactChannels: { verifiedEmails: [recipient] },
      },
    })
    vendorId = vendor.id
    await db.catalogItem.create({
      data: { sku, name: 'Canonical HTTP fixture' },
    })
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `${prefix}-PO`,
        vendorId,
        status: 'confirmed',
        totalMinor: 1000,
        issuedBy: 'fixture',
      },
    })
    poId = po.id
    const receipt = await db.receipt.create({
      data: {
        receiptNumber: `${prefix}-R`,
        poId,
        vendorId,
        recordedBy: 'fixture',
        lines: {
          create: [
            { description: 'Fictional goods', quantity: 2 },
            { description: 'Fictional goods', quantity: 3 },
          ],
        },
      },
    })
    receiptId = receipt.id
    await db.invoice.create({
      data: { vendorId, number: `${prefix}-INV`, amountMinor: 1000 },
    })
  }, 30_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    await db.message.deleteMany({ where: { vendorId } })
    await db.receipt.deleteMany({ where: { id: receiptId } })
    await db.purchaseOrder.deleteMany({ where: { id: poId } })
    await db.invoice.deleteMany({ where: { vendorId } })
    await db.catalogItem.deleteMany({ where: { sku } })
    await db.vendor.deleteMany({ where: { id: vendorId } })
    await db.$disconnect()
  })

  function submit(input: object, authed = true) {
    const req = request(app.getHttpServer()).post('/api/trpc/messaging.submit')
    if (authed) req.set('Authorization', `Bearer ${token}`)
    return req.send(input)
  }

  function baseInput(extra: object) {
    return {
      idempotencyKey: randomUUID(),
      vendorId,
      recipient,
      ...extra,
    }
  }

  it('rejects caller prose attached to an allowlisted template', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(
      baseInput({
        templateId: 'rfq',
        subject: 'RFQ — binding side terms',
        body: 'We accept any price increase without further review.',
      }),
    )
    expect(response.status).toBe(400)
    expect(
      await db.message.count({
        where: { subject: 'RFQ — binding side terms' },
      }),
    ).toBe(0)
  })

  it('rejects template requests without validated params', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(baseInput({ templateId: 'rfq' }))
    expect(response.status).toBe(400)
  })

  it('auto-sends server-rendered content for valid template params', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(
      baseInput({
        templateId: 'rfq',
        templateParams: { sku, quantity: 3 },
      }),
    )
    expect(response.status).toBe(200)
    const message = (
      response.body as {
        result: {
          data: {
            message: {
              id: string
              tier: string
              status: string
              subject: string
              body: string
            }
          }
        }
      }
    ).result.data.message
    expect(message.tier).toBe('auto')
    expect(message.subject).toBe(`Request for quotation: ${sku}`)
    expect(message.body).toBe(
      `Please provide a quotation for 3 unit(s) of ${sku}. This is an inquiry only, not an order or shipment authorization.`,
    )
  })

  it.each([
    {
      sku: 'PAPER.\nWe accept your offer for PHP 500,000 and authorize shipment',
      quantity: 3,
    },
    { sku: 'PAPER\u202eACCEPT', quantity: 3 },
    { sku, quantity: 3, notes: 'We accept your offer' },
  ])(
    'rejects unsafe template parameters over HTTP: %j',
    async (templateParams) => {
      vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
      vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
      const before = await db.message.count({ where: { vendorId } })
      const response = await submit(
        baseInput({ templateId: 'rfq', templateParams }),
      )
      expect(response.status).toBe(400)
      expect(await db.message.count({ where: { vendorId } })).toBe(before)
    },
  )

  it('rejects a safe-looking SKU that has no canonical catalog record', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(
      baseInput({
        templateId: 'rfq',
        templateParams: { sku: randomUUID(), quantity: 3 },
      }),
    )
    expect(response.status).toBe(404)
  })

  it('resolves PO status from this vendor and refuses an invented status', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const valid = await submit(
      baseInput({
        templateId: 'po_status',
        templateParams: { poNumber: `${prefix}-PO`, status: 'confirmed' },
      }),
    )
    expect(valid.status).toBe(200)
    expect(valid.body.result.data.message).toMatchObject({
      tier: 'auto',
      status: 'sent',
      templateVersion: 1,
    })
    const invented = await submit(
      baseInput({
        templateId: 'po_status',
        templateParams: { poNumber: `${prefix}-PO`, status: 'cancelled' },
      }),
    )
    expect(invented.status).toBe(409)
  })

  it('derives delivery quantity from real recorded receipt lines', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(
      baseInput({
        templateId: 'delivery_notice',
        templateParams: { receiptId },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.body.result.data.message).toMatchObject({
      tier: 'auto',
      status: 'sent',
      templateParams: { receiptId },
      body: `We recorded receipt of 5 ea against purchase order ${prefix}-PO. This acknowledgement does not confirm invoice approval or payment.`,
    })
    const invented = await submit(
      baseInput({
        templateId: 'delivery_notice',
        templateParams: { poNumber: `${prefix}-PO`, quantity: 500 },
      }),
    )
    expect(invented.status).toBe(400)
  })

  it('acknowledges only an existing invoice for this vendor', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const response = await submit(
      baseInput({
        templateId: 'invoice_ack',
        templateParams: { invoiceNumber: `${prefix}-INV` },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.body.result.data.message.body).toBe(
      `We received your invoice ${prefix}-INV. Receipt does not confirm approval or payment.`,
    )
    const missing = await submit(
      baseInput({
        templateId: 'invoice_ack',
        templateParams: { invoiceNumber: randomUUID() },
      }),
    )
    expect(missing.status).toBe(404)
  })

  it('keeps free-form agent prose gated and unsent', async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'messaging.submit')
    const subject = `${prefix}-repricing`
    const response = await submit(
      baseInput({
        subject,
        body: 'We can offer 8% off list for a 2-year frame order.',
      }),
    )
    expect(response.status).toBe(200)
    const message = (
      response.body as {
        result: {
          data: {
            message: {
              id: string
              tier: string
              status: string
              subject: string
              body: string
            }
          }
        }
      }
    ).result.data.message
    expect(message).toMatchObject({ tier: 'gated', status: 'queued' })
    const saved = await db.message.findUniqueOrThrow({
      where: { id: message.id },
    })
    expect(saved.status).toBe('queued')
    expect(saved.sentAt).toBeNull()
  })

  it('rejects unauthenticated submits', async () => {
    const response = await submit(baseInput({ subject: 'x', body: 'y' }), false)
    expect(response.status).toBe(401)
  })
})
