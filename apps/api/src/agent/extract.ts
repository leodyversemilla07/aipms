import { type InvoicePayload, invoicePayloadSchema } from './invoice-payload'

/**
 * Deterministic extractor for a structured supplier document (e.g. an
 * einvoice JSON or an EDI payload that already carries canonical fields).
 * An LLM-backed extractor replaces this via the AGENT_EXTRACTOR provider to
 * handle free-form / unstructured source documents; the agent treats the
 * extractor as a seam and never parses raw itself.
 *
 * Accepts either a flat invoice payload or a `{ docType: 'invoice', payload }`
 * envelope, so channels that wrap attachments can feed the same shape.
 */
export function extractStructuredInvoice(raw: unknown): InvoicePayload {
  const record =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const inner = record.docType === 'invoice' ? record.payload : record
  const parsed = invoicePayloadSchema.safeParse(inner)
  if (!parsed.success) {
    throw new Error(
      `Cannot extract invoice from structured document: ${parsed.error.message}`,
    )
  }
  return parsed.data
}
