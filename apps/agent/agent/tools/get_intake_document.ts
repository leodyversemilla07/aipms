import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description:
    "Fetches one prompt-safe intake document for classification. Payment credentials and attachment bodies are redacted server-side. Binary-only invoices require the configured OCR integration or human review.",
  inputSchema: z.object({ id: z.string().min(1) }),
  async execute(input) {
    return await trpcQuery("intake", "detail", input)
  },
  toModelOutput(result: RelayPayload) {
    if (!result?.id) {
      return { type: "text", value: "Intake document was not found." }
    }
    const projection = JSON.stringify(
      {
        id: result.id,
        channel: result.channel,
        senderId: result.senderId,
        status: result.status,
        raw: result.raw,
        classified: result.classified,
      },
      null,
      2
    )
    return {
      type: "text",
      value:
        projection.length > 30_000
          ? `${projection.slice(0, 30_000)}\n[DOCUMENT PROJECTION TRUNCATED]`
          : projection,
    }
  },
})
