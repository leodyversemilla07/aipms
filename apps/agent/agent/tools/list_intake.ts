import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Lists pending intake documents.",
  inputSchema: z.object({
    status: z.string().optional().default("new"),
  }),
  async execute(input) {
    return await trpcQuery("intake", "list", { status: input.status ?? "new" })
  },

  toModelOutput(result: RelayPayload) {
    if (!result || !Array.isArray(result))
      return { type: "text", value: "No intake documents found." }
    const docs = result
      .map(
        (doc: RelayPayload) =>
          `- ID: ${doc.id}, Status: ${doc.status}, Type: ${doc.type || "Unknown"}`
      )
      .join("\n")
    return {
      type: "text",
      value: `Found ${result.length} intake documents.\n${docs}`,
    }
  },
})
