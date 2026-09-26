import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcMutate } from "../lib/trpc-client"

const invoicePayload = z.object({
  kind: z.string().optional(),
  vendorId: z.string().min(1),
  number: z.string().min(1),
  poId: z.string().min(1).optional().nullable(),
  currencyCode: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().optional(),
        amountMinor: z.number().int().nonnegative(),
        class: z.enum(["goods", "services", "professional", "rental", "other"]),
        vatExempt: z.boolean().optional(),
      })
    )
    .min(1),
})

export default defineTool({
  description:
    "Attaches a validated invoice classification to an intake document. Inspect the prompt-safe document first; monetary values are integer minor units and bank/payment data must never be copied into the classification.",
  inputSchema: z.object({
    id: z.string().min(1),
    classified: invoicePayload,
    idempotencyKey: z.string().min(1).optional(),
  }),
  async execute(input, ctx) {
    return await trpcMutate("intake", "classify", {
      ...input,
      idempotencyKey:
        input.idempotencyKey ?? `eve:intake.classify:${ctx.callId}`,
    })
  },

  toModelOutput(result: RelayPayload) {
    return {
      type: "text",
      value: `Classification successful. Document ${result?.id || "updated"} is now ${result?.status || "classified"}.`,
    }
  },
})
