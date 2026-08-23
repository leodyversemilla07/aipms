import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"

/**
 * Sourcing agent tools — list vendors. Authenticated via
 * AIPMS_SERVICE_TOKEN (Bearer auth). Returns are normalized for the model.
 */
export default defineTool({
  description: "List vendors, optionally filtered by status and search query.",
  inputSchema: z.object({
    query: z.string().optional(),
    status: z.enum(["qualified", "pending", "blacklisted"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async execute({ query, status, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" }

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/vendor/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, status, limit: limit ?? 50 }),
    })
    if (!res.ok) {
      const txt = await res.text()
      return { error: `vendor/list ${res.status}: ${txt.slice(0, 200)}` }
    }
    return { ok: true, ...(await res.json()) }
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Vendor list failed: ${output.error}` }

    const vendors = (output as RelayPayload)?.vendors ?? []
    return {
      type: "text",
      value: `Found ${vendors.length} vendor(s)${
        vendors.length
          ? `\n${vendors
              .slice(0, 5)
              .map(
                (v: RelayPayload) =>
                  `- ${v.name} (${v.status}) — ${v.email ?? "no email"}`
              )
              .join("\n")}`
          : ""
      }`,
    }
  },
})
