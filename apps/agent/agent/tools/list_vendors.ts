import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Lists vendors.",
  inputSchema: z.object({
    q: z.string().optional(),
    page: z.number().optional().default(1),
    pageSize: z.number().optional().default(25),
  }),
  async execute(input) {
    return await trpcQuery("vendor", "list", input)
  },

  toModelOutput(result: RelayPayload) {
    const items = Array.isArray(result) ? result : result?.items
    if (!items || !Array.isArray(items))
      return { type: "text", value: "No vendors found." }
    const summary = items

      .map(
        (v: RelayPayload) =>
          `- ID: ${v.id}, Name: ${v.name}, Status: ${v.status}`
      )
      .join("\n")
    return { type: "text", value: `Found ${items.length} vendors.\n${summary}` }
  },
})
