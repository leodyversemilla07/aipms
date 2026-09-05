import { z } from "zod"
import { trpcMutate } from "./trpc-client"

export const messageInput = z.object({
  vendorId: z.string().min(1),
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  templateId: z
    .enum(["rfq", "po_status", "delivery_notice", "invoice_ack"])
    .optional(),
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

export async function submitVendorMessage(
  input: z.infer<typeof messageInput>,
  callId: string
) {
  if (!input.idempotencyKey && !callId)
    throw new Error(
      "Message submission requires an idempotency key or eve call ID"
    )
  const payload = messageInput.parse(input)
  return resultSchema.parse(
    await trpcMutate("messaging", "submit", {
      ...payload,
      idempotencyKey:
        payload.idempotencyKey ?? `eve:messaging.submit:${callId}`,
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
  return submitVendorMessage(
    {
      vendorId: input.vendorId,
      recipient: input.recipient,
      subject: `Request for quotation: ${input.catalogItemSku}`,
      body:
        `Please provide a quotation for ${input.quantity} unit(s) of ${input.catalogItemSku}.` +
        (input.notes ? `\n\n${input.notes}` : ""),
      // Arbitrary notes may include commercial commitments: require review.
      templateId: input.notes ? undefined : "rfq",
      idempotencyKey: input.idempotencyKey,
    },
    callId
  )
}
