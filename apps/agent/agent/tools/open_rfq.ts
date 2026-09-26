import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcMutate } from "../lib/trpc-client"

const quoteSchema = z.object({
  id: z.string(),
  requisitionId: z.string(),
  vendorId: z.string(),
  status: z.string(),
  currencyCode: z.string(),
})

export default defineTool({
  description:
    "Opens structured RFQ records for an approved requisition and selected vendors. This does not send email; use request_quote separately through the controlled messaging relay.",
  inputSchema: z.object({
    requisitionId: z.string().min(1),
    vendorIds: z.array(z.string().min(1)).min(1).max(100),
    idempotencyKey: z.string().min(1).optional(),
  }),
  async execute(input, ctx) {
    const result = await trpcMutate("sourcing", "request", {
      ...input,
      idempotencyKey:
        input.idempotencyKey ?? `eve:sourcing.request:${ctx.callId}`,
    })
    return z.array(quoteSchema).parse(result)
  },
  toModelOutput(result) {
    return {
      type: "text",
      value: `Opened ${result.length} structured RFQ record(s): ${result
        .map((quote) => `${quote.id} for vendor ${quote.vendorId}`)
        .join(
          ", "
        )}. Send each invitation separately through the messaging relay.`,
    }
  },
})
