import { defineTool } from "eve/tools"
import { z } from "zod"
import { defineAipmsTool } from "../lib/agent-tool"
import { fetchWithDeadline } from "../lib/http-client"
import {
  agentAuthorizationToken,
  agentRunId,
  getApiConfig,
} from "../lib/trpc-client"

/**
 * §7.1 — close the agent run this session owns.
 *
 * The API records an eve wake as a running trace. Without this call the run
 * would stay open until the stale-run recovery cancels it, and the run
 * history would never show what the agent actually did.
 */
export default defineAipmsTool(
  defineTool({
    description:
      "Close the current agent run with its final outcome and a short summary. " +
      "Call this exactly once when the work this run was woken for is finished or has failed, " +
      "so the run does not stay open.",
    inputSchema: z.object({
      outcome: z.enum(["succeeded", "failed"]),
      summary: z.string().trim().max(2000).optional(),
    }),
    async execute(input) {
      const { apiUrl } = getApiConfig()
      const token = await agentAuthorizationToken()
      // The run id is the eve session id. It travels in the body as well as
      // in the token claim, so a pre-minted bearer (no run claim) can still
      // close its own run.
      const runId = agentRunId()
      const res = await fetchWithDeadline(
        `${apiUrl}/api/service/agent/run/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            ...input,
            ...(runId ? { runId } : {}),
          }),
        }
      )
      if (!res.ok) {
        const error = (await res.text()).slice(0, 300)
        return { ok: false as const, status: res.status, error }
      }
      const body = (await res.json()) as {
        id?: string
        status?: string
      }
      return {
        ok: true as const,
        run: { id: body.id ?? null, status: body.status ?? null },
      }
    },
    toModelOutput(output) {
      if (!output.ok) {
        return {
          type: "text",
          value: `Run completion failed (${output.status}): ${output.error}`,
        }
      }
      return {
        type: "text",
        value: `Run ${output.run.id ?? "unknown"} closed as ${output.run.status ?? "unknown"}.`,
      }
    },
  })
)
