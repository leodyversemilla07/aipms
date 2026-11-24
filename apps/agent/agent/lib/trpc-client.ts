/**
 * Lightweight tRPC HTTP client for the agent runtime.
 * All agent tools call the API through this module.
 *
 * Wire format follows the tRPC v11 HTTP protocol:
 *   - queries:   GET  /api/trpc/<router>.<procedure>?input=<JSON input>
 *   - mutations: POST /api/trpc/<router>.<procedure> with the JSON input as body
 */

import { currentAgentRunId } from "./agent-tool"
import { fetchWithDeadline } from "./http-client"

export function getApiConfig() {
  const apiUrl = process.env.AIPMS_API_URL ?? "http://localhost:3001"
  const token = process.env.AIPMS_SERVICE_TOKEN
  if (!token)
    throw new Error("AIPMS_SERVICE_TOKEN must be set in the agent environment")
  return { apiUrl, token }
}

/**
 * §7.1 — the run this call belongs to. The eve session id is the run identity
 * the API recorded when it woke the session, so every tool call of that
 * session carries the same run id. `AIPMS_AGENT_RUN_ID` is the fallback for
 * sessions that were not started by an API wake.
 */
export function agentRunId(): string | undefined {
  return currentAgentRunId() ?? process.env.AIPMS_AGENT_RUN_ID ?? undefined
}

// One scoped bearer per run: the run id is a claim inside the token, so
// tokens cannot be shared between sessions.
const accessTokens = new Map<string, { token: string; expiresAt: number }>()

export async function agentAuthorizationToken(options?: { runId?: string }) {
  const configured = process.env.AIPMS_AGENT_BEARER_TOKEN
  if (configured) return configured

  const { apiUrl, token: bootstrapToken } = getApiConfig()
  const exchange =
    process.env.NODE_ENV === "production" ||
    process.env.AIPMS_AGENT_TOKEN_EXCHANGE === "true"
  if (!exchange) return bootstrapToken

  const runId = options?.runId ?? agentRunId()
  const cacheKey = runId ?? "default"
  const now = Date.now()
  const cached = accessTokens.get(cacheKey)
  if (cached && cached.expiresAt - 30_000 > now) {
    return cached.token
  }
  const res = await fetchWithDeadline(`${apiUrl}/api/service/agent/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bootstrapToken}`,
    },
    body: JSON.stringify({
      runId: runId || undefined,
    }),
  })
  if (!res.ok) {
    throw new Error(`Agent token exchange failed (${res.status})`)
  }
  const body = (await res.json()) as {
    accessToken?: unknown
    expiresAt?: unknown
  }
  if (
    typeof body.accessToken !== "string" ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(body.expiresAt))
  ) {
    throw new Error("Agent token exchange returned an invalid response")
  }
  accessTokens.set(cacheKey, {
    token: body.accessToken,
    expiresAt: Date.parse(body.expiresAt),
  })
  return body.accessToken
}

export async function trpcQuery<T = unknown>(
  router: string,
  procedure: string,
  input: Record<string, unknown>
): Promise<T> {
  const { apiUrl } = getApiConfig()
  const token = await agentAuthorizationToken()
  const url = new URL(`${apiUrl}/api/trpc/${router}.${procedure}`)
  url.searchParams.set("input", JSON.stringify(input))
  const res = await fetchWithDeadline(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `tRPC query ${router}.${procedure} failed (${res.status}): ${text.slice(0, 300)}`
    )
  }
  const data = await res.json()
  // Handle tRPC error responses
  if (data.error) throw new Error(`tRPC error: ${JSON.stringify(data.error)}`)
  return (data.result?.data?.json ?? data.result?.data) as T
}

export async function trpcMutate<T = unknown>(
  router: string,
  procedure: string,
  input: Record<string, unknown>
): Promise<T> {
  const { apiUrl } = getApiConfig()
  const token = await agentAuthorizationToken()
  const res = await fetchWithDeadline(
    `${apiUrl}/api/trpc/${router}.${procedure}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `tRPC mutate ${router}.${procedure} failed (${res.status}): ${text.slice(0, 300)}`
    )
  }
  const data = await res.json()
  if (data.error) throw new Error(`tRPC error: ${JSON.stringify(data.error)}`)
  return (data.result?.data?.json ?? data.result?.data) as T
}
