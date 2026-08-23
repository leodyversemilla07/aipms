import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Gets budget detail.",
  inputSchema: z.object({
    id: z.string(),
  }),
  async execute(input) {
    return await trpcQuery("budget", "detail", {
      id: input.id,
      includeRemaining: true,
    })
  },

  toModelOutput(result: RelayPayload) {
    if (!result) return { type: "text", value: "Budget not found." }
    return {
      type: "text",
      value: `Budget ${result.id}\nLimit: ${result.limit}\nCommitted: ${result.committed}\nSpent: ${result.spent}\nRemaining: ${result.remaining}`,
    }
  },
})
