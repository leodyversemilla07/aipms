import { z } from "zod"
import { trpcMutate } from "./trpc-client"

/**
 * Free-form vendor message. The backend queues these as `gated` for human
 * approval — this input has no templateId on purpose, so the generic send
 * path can never claim the transactional auto-send tier.
 */
export const messageInput = z
  .object({
    vendorId: z.string().min(1),
    recipient: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    threadId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  // Fail closed: a templateId here would silently downgrade to gated and
  // confuse the caller about what was sent, so reject it outright.
  .strict()

const templatedMessageInput = z.object({
  vendorId: z.string().min(1),
  recipient: z.string().email(),
  templateId: z.enum(["rfq", "po_status", "delivery_notice", "invoice_ack"]),
  templateParams: z.record(z.string(), z.unknown()),
  threadId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
})

const resultSchema = z.object({
  message: z.object({
    id: z.string().min(1),
    status: z.enum(["queued", "approved", "rejected", "sent", "failed"]),
    tier: z.enum(["auto", "gated"]),
  }),
})

function idempotencyKeyFor(input: { idempotencyKey?: string }, callId: string) {
  if (!input.idempotencyKey && !callId)
    throw new Error(
      "Message submission requires an idempotency key or eve call ID"
    )
  return input.idempotencyKey ?? `eve:messaging.submit:${callId}`
}

export async function submitVendorMessage(
  input: z.infer<typeof messageInput>,
  callId: string
) {
  const payload = messageInput.parse(input)
  return resultSchema.parse(
    await trpcMutate("messaging", "submit", {
      ...payload,
      idempotencyKey: idempotencyKeyFor(payload, callId),
    })
  )
}

async function submitTemplatedMessage(
  input: z.infer<typeof templatedMessageInput>,
  callId: string
) {
  const payload = templatedMessageInput.parse(input)
  return resultSchema.parse(
    await trpcMutate("messaging", "submit", {
      ...payload,
      idempotencyKey: idempotencyKeyFor(payload, callId),
    })
  )
}

export function describeMessage(result: z.infer<typeof resultSchema>) {
  const m = result.message
  const state =
    m.status === "queued" && m.tier === "gated"
      ? "queued for human approval (not sent)"
      : `status: ${m.status}`
  return `Message ${m.id} ${state}.`
}

export const quoteInput = z.object({
  vendorId: z.string().min(1),
  recipient: z
    .string()
    .email()
    .describe("Verified vendor contact; the backend checks this address"),
  catalogItemSku: z.string().min(1).max(120),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(19_000).optional(),
  idempotencyKey: z.string().min(1).optional(),
})

export async function requestQuote(
  input: z.infer<typeof quoteInput>,
  callId: string
) {
  const quote = quoteInput.parse(input)
  // Arbitrary notes may include commercial commitments: require review.
  if (quote.notes) {
    return submitVendorMessage(
      {
        vendorId: quote.vendorId,
        recipient: quote.recipient,
        subject: `Request for quotation: ${quote.catalogItemSku}`,
        body:
          `Please provide a quotation for ${quote.quantity} unit(s) of ${quote.catalogItemSku}.` +
          `\n\n${quote.notes}`,
        idempotencyKey: quote.idempotencyKey,
      },
      callId
    )
  }
  // No free prose: the backend renders this template from validated params.
  return submitTemplatedMessage(
    {
      vendorId: quote.vendorId,
      recipient: quote.recipient,
      templateId: "rfq",
      templateParams: { sku: quote.catalogItemSku, quantity: quote.quantity },
      idempotencyKey: quote.idempotencyKey,
    },
    callId
  )
}
