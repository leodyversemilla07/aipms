#!/usr/bin/env node

import { performance } from "node:perf_hooks"

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function nonnegativeNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative number`)
  }
  return value
}

const baseUrl = new URL(
  process.env.CAPACITY_BASE_URL ?? "http://localhost:3001"
)
if (baseUrl.username || baseUrl.password) {
  throw new Error("CAPACITY_BASE_URL must not contain credentials")
}
if (
  baseUrl.protocol !== "https:" &&
  process.env.CAPACITY_ALLOW_INSECURE !== "1"
) {
  throw new Error(
    "Refusing a plaintext target; set CAPACITY_ALLOW_INSECURE=1 only for local isolated stacks"
  )
}

const monitoringToken = process.env.OPERATIONS_MONITORING_TOKEN?.trim()
if (!monitoringToken) {
  throw new Error("OPERATIONS_MONITORING_TOKEN is required")
}
const bootstrapToken = (
  process.env.CAPACITY_AGENT_BOOTSTRAP_TOKEN ?? process.env.AIPMS_SERVICE_TOKEN
)?.trim()
if (!bootstrapToken) {
  throw new Error(
    "CAPACITY_AGENT_BOOTSTRAP_TOKEN (or AIPMS_SERVICE_TOKEN) is required"
  )
}

let cachedAgentAccess = null
let pendingAgentExchange = null
async function agentAuthorization() {
  if (cachedAgentAccess?.expiresAt - 30_000 > Date.now()) {
    return `Bearer ${cachedAgentAccess.token}`
  }
  if (!pendingAgentExchange) {
    pendingAgentExchange = (async () => {
      const response = await fetch(
        new URL("/api/service/agent/token", baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bootstrapToken}`,
          },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        }
      )
      if (!response.ok) {
        throw new Error(`Agent token exchange failed (${response.status})`)
      }
      const exchange = await response.json()
      const expiresAt = Date.parse(exchange?.expiresAt)
      if (
        typeof exchange?.accessToken !== "string" ||
        !Number.isFinite(expiresAt)
      ) {
        throw new Error("Agent token exchange returned an invalid response")
      }
      cachedAgentAccess = { token: exchange.accessToken, expiresAt }
    })().finally(() => {
      pendingAgentExchange = null
    })
  }
  await pendingAgentExchange
  return `Bearer ${cachedAgentAccess.token}`
}
await agentAuthorization()

const requestCount = positiveInteger("CAPACITY_REQUESTS", 300)
const concurrency = Math.min(
  positiveInteger("CAPACITY_CONCURRENCY", 20),
  requestCount
)
const timeoutMs = positiveInteger("CAPACITY_TIMEOUT_MS", 5000)
const maximumP95Ms = positiveInteger("CAPACITY_MAX_P95_MS", 1000)
const maximumErrorRate = nonnegativeNumber("CAPACITY_MAX_ERROR_RATE", 0)
if (maximumErrorRate > 1) {
  throw new Error("CAPACITY_MAX_ERROR_RATE must be between 0 and 1")
}

function trpcPath(procedure, input) {
  if (input === undefined) return `/api/trpc/${procedure}`
  const params = new URLSearchParams({ input: JSON.stringify(input) })
  return `/api/trpc/${procedure}?${params}`
}

const healthPayload = (payload) => payload?.ok === true
const trpcPayload = (payload) =>
  !payload?.error && payload?.result?.data != null
const targets = [
  { path: "/health/ready", headers: {}, valid: healthPayload },
  {
    path: "/health/operations",
    headers: { Authorization: `Bearer ${monitoringToken}` },
    valid: healthPayload,
  },
  {
    path: trpcPath("requisition.list", { q: "", page: 1, pageSize: 20 }),
    headers: async () => ({ Authorization: await agentAuthorization() }),
    valid: trpcPayload,
  },
  {
    path: trpcPath("vendor.list", { q: "", page: 1, pageSize: 20 }),
    headers: async () => ({ Authorization: await agentAuthorization() }),
    valid: trpcPayload,
  },
  {
    path: trpcPath("audit.meta"),
    headers: async () => ({ Authorization: await agentAuthorization() }),
    valid: trpcPayload,
  },
]
const latencies = []
const errors = []
let cursor = 0

async function probe(index) {
  const target = targets[index % targets.length]
  const startedAt = performance.now()
  try {
    const headers =
      typeof target.headers === "function"
        ? await target.headers()
        : target.headers
    const response = await fetch(new URL(target.path, baseUrl), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json()
    if (!response.ok || !target.valid(payload)) {
      throw new Error(`HTTP ${response.status} or unhealthy payload`)
    }
  } catch (error) {
    if (errors.length < 20) {
      errors.push({
        target: target.path,
        error: error instanceof Error ? error.message : String(error),
      })
    } else {
      errors.push(null)
    }
  } finally {
    latencies.push(performance.now() - startedAt)
  }
}

async function worker() {
  for (;;) {
    const index = cursor
    cursor += 1
    if (index >= requestCount) return
    await probe(index)
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

latencies.sort((left, right) => left - right)
const percentile = (fraction) =>
  latencies[
    Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1)
  ] ?? 0
const errorRate = errors.length / requestCount
const report = {
  target: baseUrl.origin,
  requests: requestCount,
  concurrency,
  successful: requestCount - errors.length,
  failed: errors.length,
  errorRate,
  latencyMs: {
    p50: Math.round(percentile(0.5)),
    p95: Math.round(percentile(0.95)),
    p99: Math.round(percentile(0.99)),
    max: Math.round(latencies.at(-1) ?? 0),
  },
  thresholds: {
    maximumP95Ms,
    maximumErrorRate,
  },
  errors: errors.filter(Boolean).slice(0, 20),
}
console.log(JSON.stringify(report, null, 2))

if (errorRate > maximumErrorRate || percentile(0.95) > maximumP95Ms) {
  process.exitCode = 1
}
