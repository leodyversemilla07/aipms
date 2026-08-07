import { defineTool } from "eve/tools"
import { z } from "zod"

/**
 * Drain the aipms intake queue: process up to `limit` pending documents
 * through the §3 classify→register pipeline. Calls the API's M2M REST
 * endpoint, authenticated with AIPMS_SERVICE_TOKEN (read from process.env).
 * Returns per-run counts including per-document failures.
 */
export default defineTool({
  description:
    "Run the aipms intake agent over up to `limit` pending (new) documents, " +
    "classifying and registering each as an invoice. Returns how many were " +
    "processed and any failures. Requires AIPMS_API_URL and AIPMS_SERVICE_TOKEN.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(25),
  }),
  async execute({ limit }) {
    const apiUrl = process.env.AIPMS_API_URL
    const token = process.env.AIPMS_SERVICE_TOKEN
    if (!apiUrl || !token) {
      return {
        ok: false,
        error:
          "AIPMS_API_URL and AIPMS_SERVICE_TOKEN must be set in the agent environment",
      }
    }
    const res = await fetch(`${apiUrl}/api/service/agent/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ limit }),
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
