import './no-database'
import { BadRequestException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { resolveAutoTemplate } from '../../src/messaging/auto-template'
import { MessagingService } from '../../src/messaging/messaging.service'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'

function fixture() {
  const tx = {
    catalogItem: {
      findUnique: vi.fn().mockResolvedValue({ sku: 'PAPER-1', active: true }),
    },
    purchaseOrder: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'po-1',
        poNumber: 'PO-1',
        vendorId: 'vendor-1',
        status: 'confirmed',
      }),
    },
    receipt: {
      findUnique: vi.fn().mockResolvedValue({
        vendorId: 'vendor-1',
        poId: 'po-1',
        status: 'recorded',
        lines: [
          { quantity: 2, unit: 'ea' },
          { quantity: 3, unit: 'ea' },
        ],
      }),
    },
    invoice: {
      findUnique: vi.fn().mockResolvedValue({
        vendorId: 'vendor-1',
        number: 'INV-1',
        status: 'paid',
      }),
    },
    vendor: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'vendor-1',
        status: 'active',
        contactChannels: { verifiedEmails: ['vendor@example.test'] },
      }),
    },
    message: {
      create: vi.fn(async ({ data }) => ({ id: 'message-1', ...data })),
    },
  }
  const client = tx as unknown as Prisma.TransactionClient
  const resolve = (id: string, input: unknown) =>
    resolveAutoTemplate(id, input, 'vendor-1', client)
  return { tx, client, resolve }
}

describe('canonical automatic message facts (injected clients)', () => {
  it('resolves an active catalog SKU and labels the RFQ non-binding', async () => {
    const f = fixture()
    expect(
      await f.resolve('rfq', { sku: 'PAPER-1', quantity: 3 }),
    ).toMatchObject({
      subject: 'Request for quotation: PAPER-1',
      body: 'Please provide a quotation for 3 unit(s) of PAPER-1. This is an inquiry only, not an order or shipment authorization.',
    })
    expect(f.tx.catalogItem.findUnique).toHaveBeenCalledWith({
      where: { sku: 'PAPER-1' },
    })
  })

  it('resolves the PO status instead of accepting an invented update', async () => {
    const f = fixture()
    expect(
      await f.resolve('po_status', { poNumber: 'PO-1', status: 'confirmed' }),
    ).toMatchObject({
      body: 'This is a status update for purchase order PO-1. Recorded status: confirmed.',
    })
  })

  it('derives delivery acknowledgement quantities from recorded receipt lines', async () => {
    const f = fixture()
    expect(
      await f.resolve('delivery_notice', { receiptId: 'receipt-1' }),
    ).toMatchObject({
      subject: 'Delivery receipt for PO-1',
      body: 'We recorded receipt of 5 ea against purchase order PO-1. This acknowledgement does not confirm invoice approval or payment.',
      params: { receiptId: 'receipt-1' },
    })
  })

  it('acknowledges an existing invoice without falsely claiming pending matching or payment', async () => {
    const f = fixture()
    expect(
      await f.resolve('invoice_ack', { invoiceNumber: 'INV-1' }),
    ).toMatchObject({
      body: 'We received your invoice INV-1. Receipt does not confirm approval or payment.',
    })
    expect(f.tx.invoice.findUnique).toHaveBeenCalledWith({
      where: { vendorId_number: { vendorId: 'vendor-1', number: 'INV-1' } },
    })
  })

  it.each([
    'PAPER.\nWe accept your offer for PHP 500,000 and authorize shipment',
    'PAPER WeAccept',
    'PAPER\rBcc:evil@example.test',
    'PAPER\tACCEPT',
    'PAPER\u0000ACCEPT',
    'PAPER\u202eACCEPT',
    'PAPER\u200bACCEPT',
    'ＰＡＰＥＲ',
    'PAPER;ACCEPT',
    'PAPER"ACCEPT',
  ])(
    'refuses prose/control/lookalike SKU %j before catalog access',
    async (sku) => {
      const f = fixture()
      await expect(
        f.resolve('rfq', { sku, quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(f.tx.catalogItem.findUnique).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['rfq', { sku: 'PAPER-1', quantity: 1, notes: 'We accept' }],
    ['po_status', { poNumber: 'PO-1\nWe accept', status: 'confirmed' }],
    ['po_status', { poNumber: 'PO-1', status: 'confirmed', body: 'We accept' }],
    ['invoice_ack', { invoiceNumber: 'INV-1 We accept' }],
    ['invoice_ack', { invoiceNumber: 'INV-1', quantity: 5 }],
    ['delivery_notice', { poNumber: 'PO-1', quantity: 999 }],
    ['delivery_notice', { receiptId: 'receipt-1', quantity: 999 }],
    ['rfq', { sku: 'PAPER-1', quantity: 0 }],
    ['rfq', { sku: 'PAPER-1', quantity: 1.5 }],
    ['rfq', { sku: 'PAPER-1', quantity: 1_000_000 }],
    ['rfq', { sku: 'PAPER-1', quantity: '5' }],
    ['rfq', {}],
    ['unknown', {}],
  ])('rejects malformed or extra %s parameters %j', async (id, input) => {
    await expect(fixture().resolve(id as string, input)).rejects.toBeInstanceOf(
      BadRequestException,
    )
  })

  it.each([
    null,
    { sku: 'PAPER-1', active: false },
    { sku: 'PAPER We accept', active: true },
  ])(
    'refuses absent, inactive, or unsafe canonical catalog records %j',
    async (item) => {
      const f = fixture()
      f.tx.catalogItem.findUnique.mockResolvedValue(item)
      await expect(
        f.resolve('rfq', { sku: 'PAPER-1', quantity: 1 }),
      ).rejects.toThrow()
    },
  )

  it.each([
    null,
    { vendorId: 'other-vendor', status: 'confirmed' },
    { vendorId: 'vendor-1', status: 'issued' },
    { vendorId: 'vendor-1', status: 'draft' },
  ])('refuses absent, foreign, or mismatched PO facts %j', async (po) => {
    const f = fixture()
    f.tx.purchaseOrder.findUnique.mockResolvedValue(po)
    await expect(
      f.resolve('po_status', { poNumber: 'PO-1', status: 'confirmed' }),
    ).rejects.toThrow()
  })

  it.each([
    null,
    { vendorId: 'other-vendor', number: 'INV-1' },
    { vendorId: 'vendor-1', number: 'INV We accept' },
  ])('refuses missing, foreign, or unsafe invoices %j', async (invoice) => {
    const f = fixture()
    f.tx.invoice.findUnique.mockResolvedValue(invoice)
    await expect(
      f.resolve('invoice_ack', { invoiceNumber: 'INV-1' }),
    ).rejects.toThrow()
  })

  it.each([
    null,
    { vendorId: 'other-vendor', status: 'recorded' },
    { vendorId: 'vendor-1', status: 'cancelled' },
    { vendorId: 'vendor-1', status: 'recorded', poId: 'po-1', lines: [] },
    {
      vendorId: 'vendor-1',
      status: 'recorded',
      poId: 'po-1',
      lines: [{ quantity: -1 }],
    },
    {
      vendorId: 'vendor-1',
      status: 'recorded',
      poId: 'po-1',
      lines: [{ quantity: 999_999 }, { quantity: 1 }],
    },
  ])('refuses invalid recorded receipt facts %j', async (receipt) => {
    const f = fixture()
    f.tx.receipt.findUnique.mockResolvedValue(receipt)
    await expect(
      f.resolve('delivery_notice', { receiptId: 'receipt-1' }),
    ).rejects.toThrow()
  })

  it.each([
    null,
    { vendorId: 'other-vendor', status: 'confirmed' },
    { vendorId: 'vendor-1', status: 'cancelled' },
  ])('refuses broken receipt PO links %j', async (po) => {
    const f = fixture()
    f.tx.purchaseOrder.findUnique.mockResolvedValue(po)
    await expect(
      f.resolve('delivery_notice', { receiptId: 'receipt-1' }),
    ).rejects.toThrow()
  })

  it('refuses to aggregate mixed measurement units into a delivery claim', async () => {
    const f = fixture()
    f.tx.receipt.findUnique.mockResolvedValue({
      vendorId: 'vendor-1',
      poId: 'po-1',
      status: 'recorded',
      lines: [
        { quantity: 2, unit: 'kg' },
        { quantity: 3, unit: 'ea' },
      ],
    })
    await expect(
      f.resolve('delivery_notice', { receiptId: 'receipt-1' }),
    ).rejects.toThrow(/Mixed/)
  })

  it('persists versioned provenance but never dispatches inside the staging transaction', async () => {
    const f = fixture()
    const emit = vi.fn()
    const send = vi.fn()
    const svc = new MessagingService(
      { emit } as unknown as EventEmitterService,
      { send },
    )
    const result = await svc.submit(
      {
        vendorId: 'vendor-1',
        recipient: 'vendor@example.test',
        templateId: 'rfq',
        templateParams: { sku: 'PAPER-1', quantity: 3 },
      },
      f.client,
    )
    expect(result.message).toMatchObject({
      templateId: 'rfq',
      templateVersion: 1,
      templateParams: { sku: 'PAPER-1', quantity: 3 },
      tier: 'auto',
      status: 'queued',
    })
    expect(send).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('the service rejects unsafe parameters without creating a message or event', async () => {
    const f = fixture()
    const emit = vi.fn()
    const send = vi.fn()
    const svc = new MessagingService(
      { emit } as unknown as EventEmitterService,
      { send },
    )
    await expect(
      svc.submit(
        {
          vendorId: 'vendor-1',
          recipient: 'vendor@example.test',
          templateId: 'rfq',
          templateParams: { sku: 'PAPER\nWe accept', quantity: 3 },
        },
        f.client,
      ),
    ).rejects.toThrow()
    expect(f.tx.message.create).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
