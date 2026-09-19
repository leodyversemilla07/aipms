import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcMutate } from "../lib/trpc-client"

const inputSchema = z.object({
  costCenter: z.string().min(1).max(80),
  budgetId: z.string().min(1).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  note: z.string().max(1000).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(100).optional(),
        description: z.string().min(1).max(500),
        quantity: z.number().int().positive(),
        unit: z.string().max(20).optional(),
        unitPriceMinor: z.number().int().nonnegative(),
        currencyCode: z.string().length(3).optional(),
      })
    )
    .min(1)
    .max(200),
  idempotencyKey: z.string().min(1).optional(),
})

const resultSchema = z.object({
  id: z.string(),
  requestNumber: z.string(),
  status: z.string(),
  costCenter: z.string(),
  lines: z.array(
    z.object({
      quantity: z.number(),
      unitPriceMinor: z.number(),
      currencyCode: z.string(),
    })
  ),
})

export default defineTool({
  description:
    "Creates a draft requisition with integer minor-unit prices. Every line must use one matching currency. This does not submit the draft for policy evaluation.",
  inputSchema,
  async execute(input, ctx) {
    const result = await trpcMutate("requisition", "create", {
      ...input,
      idempotencyKey:
        input.idempotencyKey ?? `eve:requisition.create:${ctx.callId}`,
    })
    return resultSchema.parse(result)
  },
  toModelOutput(result) {
    const totalMinor = result.lines.reduce(
      (sum, line) => sum + line.quantity * line.unitPriceMinor,
      0
    )
    const currency = result.lines[0]?.currencyCode ?? "PHP"
    return {
      type: "text",
      value: `Draft ${result.requestNumber} created (${result.id}). Total: ${totalMinor} minor units ${currency}. Submit it separately for policy evaluation.`,
    }
  },
})
