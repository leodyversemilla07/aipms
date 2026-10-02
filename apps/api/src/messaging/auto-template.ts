import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { z } from 'zod'

export const AUTO_TEMPLATES = [
  'rfq',
  'po_status',
  'delivery_notice',
  'invoice_ack',
] as const
export type AutoTemplateId = (typeof AUTO_TEMPLATES)[number]
export const AUTO_TEMPLATE_VERSION = 1

// Identifiers, not prose: reject whitespace, controls, bidi/zero-width text,
// delimiters, and Unicode lookalikes. Unusual business identifiers need review.
const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
const quantity = z.number().int().min(1).max(999_999)
const schemas = {
  rfq: z.object({ sku: token(120), quantity }).strict(),
  po_status: z
    .object({
      poNumber: token(60),
      status: z.enum(['issued', 'confirmed', 'cancelled']),
    })
    .strict(),
  // Delivery acknowledgements must reference a real recorded receipt, not
  // manufacture expected delivery from a caller's PO number and quantity.
  delivery_notice: z.object({ receiptId: token(120) }).strict(),
  invoice_ack: z.object({ invoiceNumber: token(60) }).strict(),
}

export type AutoTemplateParams = {
  rfq: { sku: string; quantity: number }
  po_status: { poNumber: string; status: 'issued' | 'confirmed' | 'cancelled' }
  delivery_notice: { poNumber: string; quantity: number; unit: string }
  invoice_ack: { invoiceNumber: string }
}

export function renderAutoTemplate(
  templateId: AutoTemplateId,
  params: AutoTemplateParams[AutoTemplateId],
) {
  switch (templateId) {
    case 'rfq': {
      const p = params as AutoTemplateParams['rfq']
      return {
        subject: `Request for quotation: ${p.sku}`,
        body: `Please provide a quotation for ${p.quantity} unit(s) of ${p.sku}. This is an inquiry only, not an order or shipment authorization.`,
      }
    }
    case 'po_status': {
      const p = params as AutoTemplateParams['po_status']
      return {
        subject: `Purchase order ${p.poNumber}: ${p.status}`,
        body: `This is a status update for purchase order ${p.poNumber}. Recorded status: ${p.status}.`,
      }
    }
    case 'delivery_notice': {
      const p = params as AutoTemplateParams['delivery_notice']
      return {
        subject: `Delivery receipt for ${p.poNumber}`,
        body: `We recorded receipt of ${p.quantity} ${p.unit} against purchase order ${p.poNumber}. This acknowledgement does not confirm invoice approval or payment.`,
      }
    }
    case 'invoice_ack': {
      const p = params as AutoTemplateParams['invoice_ack']
      return {
        subject: `Invoice ${p.invoiceNumber} received`,
        body: `We received your invoice ${p.invoiceNumber}. Receipt does not confirm approval or payment.`,
      }
    }
  }
}

function canonicalToken(value: string, max: number) {
  if (!token(max).safeParse(value).success) {
    throw new BadRequestException(
      'Canonical identifier is not safe for automatic messaging; use a reviewed free-form draft',
    )
  }
  return value
}

/** Resolve facts in the caller's staging/claim transaction; never trust prose. */
export async function resolveAutoTemplate(
  templateId: string,
  input: unknown,
  vendorId: string,
  tx: Prisma.TransactionClient,
) {
  if (!(AUTO_TEMPLATES as readonly string[]).includes(templateId)) {
    throw new BadRequestException('Unknown automatic template')
  }
  const id = templateId as AutoTemplateId
  const parsed = schemas[id].safeParse(input)
  if (!parsed.success) {
    throw new BadRequestException(
      `Invalid parameters for template "${id}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    )
  }
  let facts: AutoTemplateParams[AutoTemplateId]
  switch (id) {
    case 'rfq': {
      const p = parsed.data as z.infer<typeof schemas.rfq>
      const item = await tx.catalogItem.findUnique({ where: { sku: p.sku } })
      if (!item?.active)
        throw new NotFoundException(
          'RFQ requires an active canonical catalog item',
        )
      facts = { sku: canonicalToken(item.sku, 120), quantity: p.quantity }
      break
    }
    case 'po_status': {
      const p = parsed.data as z.infer<typeof schemas.po_status>
      const po = await tx.purchaseOrder.findUnique({
        where: { poNumber: p.poNumber },
      })
      if (!po || po.vendorId !== vendorId)
        throw new NotFoundException(
          'Purchase order does not belong to this vendor',
        )
      if (po.status !== p.status)
        throw new ConflictException(
          'Requested PO status does not match the canonical purchase order',
        )
      facts = { poNumber: canonicalToken(po.poNumber, 60), status: p.status }
      break
    }
    case 'delivery_notice': {
      const p = parsed.data as z.infer<typeof schemas.delivery_notice>
      const receipt = await tx.receipt.findUnique({
        where: { id: p.receiptId },
        include: { lines: true },
      })
      if (
        !receipt ||
        receipt.vendorId !== vendorId ||
        receipt.status !== 'recorded'
      ) {
        throw new NotFoundException(
          'Delivery acknowledgement requires a recorded receipt for this vendor',
        )
      }
      const po = await tx.purchaseOrder.findUnique({
        where: { id: receipt.poId },
      })
      if (
        !po ||
        po.vendorId !== vendorId ||
        !['issued', 'confirmed'].includes(po.status)
      ) {
        throw new ConflictException(
          'Receipt purchase order is not live for this vendor',
        )
      }
      const total = receipt.lines.reduce((sum, line) => sum + line.quantity, 0)
      if (
        !receipt.lines.length ||
        receipt.lines.some(
          (line) => !quantity.safeParse(line.quantity).success,
        ) ||
        !quantity.safeParse(total).success
      ) {
        throw new ConflictException(
          'Receipt quantities are not safe for automatic acknowledgement',
        )
      }
      const units = new Set(
        receipt.lines.map((line) => canonicalToken(line.unit, 20)),
      )
      if (units.size !== 1)
        throw new ConflictException(
          'Mixed receipt units require a reviewed delivery acknowledgement',
        )
      facts = {
        poNumber: canonicalToken(po.poNumber, 60),
        quantity: total,
        unit: canonicalToken(receipt.lines[0]?.unit ?? '', 20),
      }
      break
    }
    case 'invoice_ack': {
      const p = parsed.data as z.infer<typeof schemas.invoice_ack>
      const invoice = await tx.invoice.findUnique({
        where: { vendorId_number: { vendorId, number: p.invoiceNumber } },
      })
      if (!invoice || invoice.vendorId !== vendorId)
        throw new NotFoundException('Invoice does not belong to this vendor')
      facts = { invoiceNumber: canonicalToken(invoice.number, 60) }
      break
    }
  }
  return { ...renderAutoTemplate(id, facts), params: parsed.data }
}

/** Old auto rows have no proof of safe composition and must not be replayed. */
export async function assertAutoTemplateContent(
  message: {
    vendorId: string
    templateId: string | null
    templateVersion: number | null
    templateParams: unknown
    subject: string
    body: string
  },
  tx: Prisma.TransactionClient,
) {
  if (
    message.templateVersion !== AUTO_TEMPLATE_VERSION ||
    !message.templateId
  ) {
    throw new ConflictException(
      'Automatic message lacks supported template provenance; human review is required',
    )
  }
  const canonical = await resolveAutoTemplate(
    message.templateId,
    message.templateParams,
    message.vendorId,
    tx,
  )
  if (
    message.subject !== canonical.subject ||
    message.body !== canonical.body
  ) {
    throw new ConflictException(
      'Automatic message no longer matches canonical template facts; human review is required',
    )
  }
}
