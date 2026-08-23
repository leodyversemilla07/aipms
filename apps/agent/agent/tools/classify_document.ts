import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcMutate } from "../lib/trpc-client"

export default defineTool({
  description: "Attaches classification to an intake document.",
  inputSchema: z.object({
    id: z.string(),
    classified: z.object({
      vendorHint: z.string().optional(),
      documentType: z.string(),
      amounts: z.record(z.string(), z.any()).optional(),
      lineItems: z.array(z.any()).optional(),
    }),
  }),
  async execute(input) {
    return await trpcMutate("intake", "classify", {
      id: input.id,
      classified: input.classified,
    })
  },

  toModelOutput(result: RelayPayload) {
    return {
      type: "text",
      value: `Classification successful. Document ${result?.id || "updated"} is now ${result?.status || "classified"}.`,
    }
  },
})
