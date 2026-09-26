#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createServer } from "node:http"

const token = "monitoring-test-token"
let deadLetters = 0
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url === "/health/ready") {
    response.end(JSON.stringify({ status: "ready" }))
    return
  }
  if (
    request.url === "/health/operations" &&
    request.headers.authorization === `Bearer ${token}`
  ) {
    response.end(
      JSON.stringify({
        status: "observed",
        exceptions: {
          deadLetters,
          relayClaims: 0,
          staleRelayClaims: 0,
          staleAgentRuns: 0,
          failedMessages: 0,
          ambiguousErpDispatches: 0,
          checkedAt: new Date().toISOString(),
        },
      })
    )
    return
  }
  response.statusCode = 401
  response.end(JSON.stringify({ error: "unauthorized" }))
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
const url = `http://127.0.0.1:${address.port}`

function run() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/operations-check.mjs"], {
      env: {
        ...process.env,
        OPERATIONS_API_URL: url,
        OPERATIONS_MONITORING_TOKEN: token,
        OPERATIONS_ALLOW_INSECURE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      output += chunk
    })
    child.on("close", (code) => resolve({ code, output }))
  })
}

try {
  const healthy = await run()
  if (healthy.code !== 0 || !JSON.parse(healthy.output).ok) {
    throw new Error("operations check rejected healthy gauges")
  }
  deadLetters = 1
  const unhealthy = await run()
  if (
    unhealthy.code === 0 ||
    !JSON.parse(unhealthy.output).failures.includes("deadLetters_threshold")
  ) {
    throw new Error("operations check accepted a dead letter")
  }
  process.stdout.write("Operations check self-test passed.\n")
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}
