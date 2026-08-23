import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"

/**
 * Sourcing agent tools — read budget envelopes. Authenticated via
 * AIPMS_SERVICE_TOKEN (Bearer auth). Reads budget state; no mutation.
 */
export default defineTool({
  description:
    "List budget envelopes for a cost center/period. Reads budget state; no mutation.",
  inputSchema: z.object({
    costCenter: z.string().optional(),
    period: z.string().optional(),
    limit: z.number().int().min(1).max(12).optional(),
  }),
  async execute({ costCenter, period, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" }

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/budget/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ costCenter, period, limit: limit ?? 12 }),
    })
    if (!res.ok) {
      const txt = await res.text()
      return { error: `budget/list ${res.status}: ${txt.slice(0, 200)}` }
    }
    return { ok: true, ...(await res.json()) }
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Budget list failed: ${output.error}` }

    const budgets = (output as RelayPayload)?.budgets ?? []
    return {
      type: "text",
      value: `Found ${budgets.length} budget envelope(s)${
        budgets.length
          ? `\n${budgets
              .slice(0, 3)
              .map(
                (b: RelayPayload) =>
                  `- ${b.costCenter} · limit ₱${(b.limit / 100).toFixed(2)} · spent ₱${(
                    b.spent / 100
                  ).toFixed(2)} · committed ₱${(b.committed / 100).toFixed(2)}`
              )
              .join("\n")}`
          : ""
      }`,
    }
  },
})
