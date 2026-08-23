import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"

/**
 * Sourcing agent tools — request vendor quotes through the relay.
 * Authenticated via AIPMS_SERVICE_TOKEN (Bearer auth).
 */
export default defineTool({
  description:
    "Request a vendor quote for a catalog item. The agent sends a structured quote request to the vendor relay.",
  inputSchema: z.object({
    vendorId: z.string(),
    catalogItemSku: z.string(),
    quantity: z.number().int().min(1).optional(),
    notes: z.string().optional(),
  }),
  async execute({ vendorId, catalogItemSku, quantity, notes }) {
    const token = process.env.AIPMS_SERVICE_TOKEN
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" }

    const res = await fetch(
      `${process.env.AIPMS_API_URL}/api/messaging/submit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          vendorId,
          catalogItemSku,
          quantity: quantity ?? 1,
          notes,
          tier: "auto", // low-risk: RFQ / status inquiry
        }),
      }
    )
    if (!res.ok) {
      const txt = await res.text()
      return { error: `messaging/submit ${res.status}: ${txt.slice(0, 200)}` }
    }
    return { ok: true, ...(await res.json()) }
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Quote request failed: ${output.error}` }
    const { requestId, status } = output as RelayPayload
    return {
      type: "text",
      value: `Quote request ${status === "approved" ? "submitted" : "pending"} (${requestId ?? "N/A"})`,
    }
  },
})
