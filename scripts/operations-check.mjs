#!/usr/bin/env node

const baseRaw = process.env.OPERATIONS_API_URL
const token = process.env.OPERATIONS_MONITORING_TOKEN
if (!baseRaw) throw new Error("OPERATIONS_API_URL is required")
if (!token) throw new Error("OPERATIONS_MONITORING_TOKEN is required")
const base = new URL(baseRaw)
if (base.username || base.password) {
  throw new Error("OPERATIONS_API_URL must not contain credentials")
}
if (
  base.protocol !== "https:" &&
  process.env.OPERATIONS_ALLOW_INSECURE !== "1"
) {
  throw new Error("OPERATIONS_API_URL must use HTTPS")
}
const timeoutMs = Number.parseInt(
  process.env.OPERATIONS_TIMEOUT_MS ?? "10000",
  10
)
const maxObservationAgeMs = Number.parseInt(
  process.env.OPERATIONS_MAX_OBSERVATION_AGE_MS ?? "120000",
  10
)
const thresholdNames = [
  "deadLetters",
  "relayClaims",
  "staleRelayClaims",
  "staleAgentRuns",
  "failedMessages",
  "ambiguousErpDispatches",
]
const thresholds = Object.fromEntries(
  thresholdNames.map((name) => [
    name,
    Number.parseInt(
      process.env[
        `OPERATIONS_MAX_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}`
      ] ?? (name === "relayClaims" ? "100" : "0"),
      10
    ),
  ])
)

async function get(path, authenticated = false) {
  const response = await fetch(new URL(path, base), {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return response.json()
}

const failures = []
let exceptions = {}
try {
  const ready = await get("/health/ready")
  if (ready.status !== "ready") failures.push("readiness_not_ready")
  const operations = await get("/health/operations", true)
  exceptions = operations.exceptions ?? {}
  const checkedAt = Date.parse(exceptions.checkedAt ?? "")
  if (!Number.isFinite(checkedAt)) failures.push("invalid_observation_time")
  else if (Date.now() - checkedAt > maxObservationAgeMs)
    failures.push("stale_observation")
  for (const name of thresholdNames) {
    const value = exceptions[name]
    if (!Number.isInteger(value) || value < 0) {
      failures.push(`invalid_${name}`)
    } else if (value > thresholds[name]) {
      failures.push(`${name}_threshold`)
    }
  }
} catch (error) {
  failures.push("probe_failed")
  exceptions = {
    probeError: error instanceof Error ? error.message : "unknown",
  }
}

const output = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  target: base.origin,
  failures,
  thresholds,
  exceptions,
}
process.stdout.write(`${JSON.stringify(output)}\n`)
if (failures.length > 0) process.exitCode = 1
