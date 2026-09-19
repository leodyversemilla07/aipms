import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcMutate } from "../lib/trpc-client"

const inputSchema = z.object({
  id: z.string().min(1),
  totalMinor: z.number().int().positive(),
  currencyCode: z.string().length(3).optional(),
  leadTimeDays: z.number().int().positive().optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().optional(),
        description: z.string().min(1),
        quantity: z.number().int().positive().optional(),
        unitPriceMinor: z.number().int().nonnegative().optional(),
        amountMinor: z.number().int().nonnegative(),
      })
    )
    .optional(),
  idempotencyKey: z.string().min(1).optional(),
})

const resultSchema = z.object({
  id: z.string(),
  requisitionId: z.string(),
  vendorId: z.string(),
  status: z.string(),
  totalMinor: z.number().int().nullable(),
  currencyCode: z.string(),
  leadTimeDays: z.number().int().nullable(),
})

export default defineTool({
  description:
    "Records a structured vendor offer against an open RFQ. Values are integer minor units and currency must match the requisition; no FX conversion is performed.",
  inputSchema,
  async execute(input, ctx) {
    const result = await trpcMutate("sourcing", "receive", {
      ...input,
      idempotencyKey:
        input.idempotencyKey ?? `eve:sourcing.receive:${ctx.callId}`,
    })
    return resultSchema.parse(result)
  },
  toModelOutput(result) {
    return {
      type: "text",
      value: `Offer ${result.id} recorded for vendor ${result.vendorId}: ${result.totalMinor} minor units ${result.currencyCode}${result.leadTimeDays ? `, ${result.leadTimeDays} day lead time` : ""}. A human must award the quote.`,
    }
  },
})
