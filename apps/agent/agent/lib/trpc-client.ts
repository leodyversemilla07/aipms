/**
 * Lightweight tRPC HTTP client for the agent runtime.
 * All agent tools call the API through this module.
 *
 * Wire format follows the tRPC v11 HTTP protocol:
 *   - queries:   GET  /api/trpc/<router>.<procedure>?input=<JSON input>
 *   - mutations: POST /api/trpc/<router>.<procedure> with the JSON input as body
 */

export function getApiConfig() {
  const apiUrl = process.env.AIPMS_API_URL ?? "http://localhost:3001"
  const token = process.env.AIPMS_SERVICE_TOKEN
  if (!token)
    throw new Error("AIPMS_SERVICE_TOKEN must be set in the agent environment")
  return { apiUrl, token }
}

let cachedAccess: { token: string; expiresAt: number } | null = null

export async function agentAuthorizationToken() {
  const configured = process.env.AIPMS_AGENT_BEARER_TOKEN
  if (configured) return configured

  const { apiUrl, token: bootstrapToken } = getApiConfig()
  const exchange =
    process.env.NODE_ENV === "production" ||
    process.env.AIPMS_AGENT_TOKEN_EXCHANGE === "true"
  if (!exchange) return bootstrapToken

  const now = Date.now()
  if (cachedAccess && cachedAccess.expiresAt - 30_000 > now) {
    return cachedAccess.token
  }
  const res = await fetch(`${apiUrl}/api/service/agent/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bootstrapToken}`,
    },
    body: JSON.stringify({
      runId: process.env.AIPMS_AGENT_RUN_ID || undefined,
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
  cachedAccess = {
    token: body.accessToken,
    expiresAt: Date.parse(body.expiresAt),
  }
  return cachedAccess.token
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
  const res = await fetch(url.toString(), {
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
  const res = await fetch(`${apiUrl}/api/trpc/${router}.${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  })
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
