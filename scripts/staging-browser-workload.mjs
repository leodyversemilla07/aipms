#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const jsonPath = resolve(
  process.env.STAGING_WORKLOAD_JSON ??
    "apps/web/test-results/staging-workload.json"
)
const evidencePath = process.env.STAGING_WORKLOAD_EVIDENCE
  ? resolve(process.env.STAGING_WORKLOAD_EVIDENCE)
  : null
const maxP95Ms = Number.parseInt(
  process.env.STAGING_WORKLOAD_MAX_P95_MS ?? "5000",
  10
)
const maxErrorRate = Number.parseFloat(
  process.env.STAGING_WORKLOAD_MAX_ERROR_RATE ?? "0"
)

mkdirSync(resolve(jsonPath, ".."), { recursive: true })
const run = spawnSync(
  "pnpm",
  [
    "--dir",
    "apps/web",
    "exec",
    "playwright",
    "test",
    "--config=playwright.staging.config.ts",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, STAGING_WORKLOAD_JSON: jsonPath },
  }
)

let report
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"))
} catch (error) {
  throw new Error(`Could not read Playwright workload report: ${error.message}`)
}

const results = []
function collect(suites = []) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) results.push(result)
      }
    }
    collect(suite.suites)
  }
}
collect(report.suites)

const durations = results
  .map((result) => result.duration)
  .filter((duration) => Number.isFinite(duration))
  .sort((left, right) => left - right)
const failures = results.filter(
  (result) => !["passed", "skipped"].includes(result.status)
).length
const percentile = (fraction) =>
  durations.length === 0
    ? null
    : durations[
        Math.min(
          durations.length - 1,
          Math.ceil(durations.length * fraction) - 1
        )
      ]
const summary = {
  source: "playwright-staging-read-only",
  generatedAt: new Date().toISOString(),
  stagingOrigin: new URL(process.env.STAGING_WEB_URL).origin,
  resultCount: results.length,
  failureCount: failures,
  errorRate: results.length === 0 ? 1 : failures / results.length,
  latencyMs: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  },
  limits: { maxP95Ms, maxErrorRate },
}

if (evidencePath) {
  mkdirSync(resolve(evidencePath, ".."), { recursive: true })
  writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  })
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (
  run.status !== 0 ||
  results.length === 0 ||
  summary.errorRate > maxErrorRate ||
  summary.latencyMs.p95 === null ||
  summary.latencyMs.p95 > maxP95Ms
) {
  process.exitCode = 1
}
