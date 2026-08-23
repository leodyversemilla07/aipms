import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Polls for domain events the agent is interested in.",
  inputSchema: z.object({
    types: z.array(z.string()),
    since: z.string().optional(),
    limit: z.number().optional(),
  }),
  async execute(input) {
    return await trpcQuery("events", "poll", input)
  },

  toModelOutput(result: RelayPayload) {
    if (!result || !Array.isArray(result))
      return { type: "text", value: "No events found." }
    const counts = result.reduce(
      (acc, ev) => {
        acc[ev.type] = (acc[ev.type] || 0) + 1
        return acc
      },
      {} as Record<string, number>
    )
    const summary = Object.entries(counts)
      .map(([type, count]) => `${count}x ${type}`)
      .join(", ")
    return {
      type: "text",
      value: `Found ${result.length} events: ${summary || "None"}`,
    }
  },
})
