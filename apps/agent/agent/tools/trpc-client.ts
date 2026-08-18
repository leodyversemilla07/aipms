import { z } from 'zod';

/**
 * Lightweight tRPC HTTP client for the agent runtime.
 * All agent tools call the API through this module.
 */

export function getApiConfig() {
  const apiUrl = process.env.AIPMS_API_URL ?? 'http://localhost:3001'
  const token = process.env.AIPMS_SERVICE_TOKEN
  if (!token) throw new Error('AIPMS_SERVICE_TOKEN must be set in the agent environment')
  return { apiUrl, token }
}

export async function trpcQuery<T = unknown>(router: string, procedure: string, input: Record<string, unknown>): Promise<T> {
  const { apiUrl, token } = getApiConfig()
  const url = new URL(`${apiUrl}/api/trpc/${router}.${procedure}`)
  url.searchParams.set('input', JSON.stringify({ json: input }))
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`tRPC query ${router}.${procedure} failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  // Handle tRPC error responses
  if (data.error) throw new Error(`tRPC error: ${JSON.stringify(data.error)}`)
  return (data.result?.data?.json ?? data.result?.data) as T
}

export async function trpcMutate<T = unknown>(router: string, procedure: string, input: Record<string, unknown>): Promise<T> {
  const { apiUrl, token } = getApiConfig()
  const res = await fetch(`${apiUrl}/api/trpc/${router}.${procedure}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ json: input }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`tRPC mutate ${router}.${procedure} failed (${res.status}): ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  if (data.error) throw new Error(`tRPC error: ${JSON.stringify(data.error)}`)
  return (data.result?.data?.json ?? data.result?.data) as T
}
