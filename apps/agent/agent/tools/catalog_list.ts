import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"

/**
 * Sourcing agent tools — browse catalog. Authenticated via
 * AIPMS_SERVICE_TOKEN (Bearer auth). Returns are normalized for the model.
 */
export default defineTool({
  description:
    "List catalog items, optionally filtered by search query and category.",
  inputSchema: z.object({
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async execute({ query, category, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" }

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/catalog/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, category, limit: limit ?? 50 }),
    })
    if (!res.ok) {
      const txt = await res.text()
      return { error: `catalog/list ${res.status}: ${txt.slice(0, 200)}` }
    }
    return { ok: true, ...(await res.json()) }
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Catalog list failed: ${output.error}` }

    const items = (output as RelayPayload)?.items ?? []
    return {
      type: "text",
      value: `Found ${items.length} catalog item(s)${
        items.length
          ? `\n${items
              .slice(0, 5)
              .map(
                (i: RelayPayload) =>
                  `- ${i.sku}: ${i.name} (${i.category || "—"}) — ₱${
                    i.defaultPriceMinor != null
                      ? `${(i.defaultPriceMinor / 100).toFixed(2)}`
                      : "no price"
                  }`
              )
              .join("\n")}`
          : ""
      }`,
    }
  },
})
