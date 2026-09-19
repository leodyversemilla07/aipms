import { defineTool } from "eve/tools"
import { z } from "zod"
import { agentAuthorizationToken, getApiConfig } from "../lib/trpc-client"

/**
 * Drain the aipms intake queue: process up to `limit` pending documents
 * through the §3 classify→register pipeline. Calls the API's M2M REST
 * endpoint, authenticated with a short-lived scoped agent bearer.
 * Returns per-run counts including per-document failures.
 */
export default defineTool({
  description:
    "Run the aipms intake agent over up to `limit` pending (new) documents, " +
    "classifying and registering each as an invoice. Returns how many were " +
    "processed and any failures. Requires configured aipms machine credentials.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(25),
  }),
  async execute({ limit }, ctx) {
    const { apiUrl } = getApiConfig()
    const token = await agentAuthorizationToken()
    const res = await fetch(`${apiUrl}/api/service/agent/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        limit,
        idempotencyKey: `eve:agent.batch:${ctx.callId}`,
      }),
    })
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text() }
    }
    return { ok: true, ...(await res.json()) }
  },
  toModelOutput(output) {
    if (!output.ok) {
      return {
        type: "text",
        value: `Intake agent call failed: ${output.error}`,
      }
    }
    return {
      type: "text",
      value:
        `Processed ${output.succeeded}/${output.documents} pending intake documents` +
        (output.failed?.length ? `; ${output.failed.length} failed` : ""),
    }
  },
})
