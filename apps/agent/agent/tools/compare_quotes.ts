import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcQuery } from "../lib/trpc-client"

const resultSchema = z.object({
  criterion: z.string(),
  priceWeight: z.number().nullable(),
  recommendedQuoteId: z.string().nullable(),
  ranking: z.array(
    z.object({
      quoteId: z.string(),
      score: z.number().nullable(),
      expired: z.boolean().optional(),
      validUntil: z.coerce.date().nullable().optional(),
    })
  ),
})

export default defineTool({
  description:
    "Computes the deterministic policy-based ranking of received quotes for a requisition. Read-only: the recommendation is not an award and requires a human procurement decision.",
  inputSchema: z.object({ requisitionId: z.string().min(1) }),
  async execute(input) {
    const result = await trpcQuery("sourcing", "compare", input)
    return resultSchema.parse(result)
  },
  toModelOutput(result) {
    const ranking = result.ranking.length
      ? result.ranking
          .map((entry, index) => {
            const exp = entry.expired ? " [EXPIRED]" : ""
            return entry.score == null
              ? `${index + 1}. ${entry.quoteId}${exp}`
              : `${index + 1}. ${entry.quoteId} (score ${entry.score})${exp}`
          })
          .join("\n")
      : "No received quotes are available."
    return {
      type: "text",
      value: `Criterion: ${result.criterion}. Recommended (not awarded): ${result.recommendedQuoteId ?? "none"}.\n${ranking}`,
    }
  },
})
