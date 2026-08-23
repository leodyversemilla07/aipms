import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Gets full requisition detail.",
  inputSchema: z.object({
    id: z.string(),
  }),
  async execute(input) {
    return await trpcQuery("requisition", "detail", { id: input.id })
  },

  toModelOutput(result: RelayPayload) {
    if (!result) return { type: "text", value: "Requisition not found." }
    const lines = result.lines ? result.lines.length : 0
    return {
      type: "text",
      value: `Requisition ${result.number || result.id}\nStatus: ${result.status}\nLines: ${lines}\nBudget: ${result.budgetId || "None"}`,
    }
  },
})
