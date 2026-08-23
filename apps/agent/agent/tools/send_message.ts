import crypto from "crypto"
import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcMutate } from "../lib/trpc-client"

/**
 * §8.3 — submits an outbound vendor message through the relay. The relay
 * verifies the recipient against the vendor master and tiers every send
 * server-side: transactional templates auto-send; free-form or binding
 * content queues for human approval. Report the returned status verbatim.
 */
export default defineTool({
  description:
    "Sends a message to a vendor through the approved relay. Recipients must be verified contacts on the vendor master; transactional templates (rfq, po_status, delivery_notice, invoice_ack) auto-send, everything else waits for human approval.",
  inputSchema: z.object({
    vendorId: z.string(),
    recipient: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1),
    templateId: z
      .enum(["rfq", "po_status", "delivery_notice", "invoice_ack"])
      .optional(),
    threadId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  async execute(input) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
    return await trpcMutate("messaging", "submit", {
      idempotencyKey,
      vendorId: input.vendorId,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      templateId: input.templateId,
      threadId: input.threadId,
    })
  },
  toModelOutput(result: any) {
    if (!result?.message) return "Message submission failed."
    const m = result.message
    const state =
      m.status === "sent"
        ? "sent"
        : m.status === "queued" && m.tier === "gated"
          ? "queued for human approval (gated tier)"
          : `status: ${m.status}`
    return `Message ${m.id} ${state}.`
  },
})
