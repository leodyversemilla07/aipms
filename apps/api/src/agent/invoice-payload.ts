import { z } from 'zod'

/**
 * The classified payload an extractor (deterministic or LLM) is expected to
 * produce for an invoice document — the exact shape InvoiceService.register
 * consumes. Single source of truth for the §9 bridge and the agent.
 */
export const invoicePayloadSchema = z.object({
  kind: z.string().optional(),
  vendorId: z.string().min(1),
  number: z.string().min(1),
  poId: z.string().min(1).optional().nullable(),
  currencyCode: z.string().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().optional(),
        amountMinor: z.number().int(),
        class: z.enum(['goods', 'services', 'professional', 'rental', 'other']),
        vatExempt: z.boolean().optional(),
      }),
    )
    .min(1),
})

export type InvoicePayload = z.infer<typeof invoicePayloadSchema>
