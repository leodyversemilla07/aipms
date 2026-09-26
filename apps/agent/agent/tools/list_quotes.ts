import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcQuery } from "../lib/trpc-client"

const inputSchema = z.object({
  requisitionId: z.string().min(1).optional(),
  status: z.enum(["requested", "received", "accepted", "rejected"]).optional(),
})

const quoteSchema = z.object({
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
    "Lists structured RFQ and quote records, optionally by requisition or status. Read-only.",
  inputSchema,
  async execute(input) {
    const result = await trpcQuery("sourcing", "list", input)
    return z.array(quoteSchema).parse(result)
  },
  toModelOutput(result) {
    if (result.length === 0) {
      return { type: "text", value: "No structured quotes matched." }
    }
    return {
      type: "text",
      value: result
        .map(
          (quote) =>
            `${quote.id}: ${quote.status}, vendor ${quote.vendorId}, ${quote.totalMinor ?? "amount pending"} minor units ${quote.currencyCode}`
        )
        .join("\n"),
    }
  },
})
