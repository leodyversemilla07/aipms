#!/usr/bin/env node

import { connect } from "node:tls"

function requiredUrl(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`)
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials`)
  }
  return url
}

function tlsCertificate(url) {
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        servername: url.hostname,
        rejectUnauthorized: true,
      },
      () => {
        const certificate = socket.getPeerCertificate()
        socket.end()
        if (!certificate?.valid_to) {
          reject(new Error(`No peer certificate returned for ${url.hostname}`))
          return
        }
        resolve(certificate)
      }
    )
    socket.setTimeout(5000, () =>
      socket.destroy(new Error(`TLS timeout for ${url.hostname}`))
    )
    socket.once("error", reject)
  })
}

async function jsonProbe(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5000),
  })
  const payload = await response.json().catch(() => null)
  return { response, payload }
}

const webUrl = requiredUrl("STAGING_WEB_URL")
const apiUrl = requiredUrl("STAGING_API_URL")
const monitoringToken = process.env.OPERATIONS_MONITORING_TOKEN?.trim()
if (!monitoringToken) throw new Error("OPERATIONS_MONITORING_TOKEN is required")
const minimumTlsDays = Number(process.env.TLS_MIN_VALID_DAYS ?? 21)
if (!Number.isInteger(minimumTlsDays) || minimumTlsDays < 1) {
  throw new Error("TLS_MIN_VALID_DAYS must be a positive integer")
}

const certificates = []
for (const url of [webUrl, apiUrl]) {
  const certificate = await tlsCertificate(url)
  const expiresAt = new Date(certificate.valid_to)
  const daysRemaining = Math.floor(
    (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
  )
  if (!Number.isFinite(daysRemaining) || daysRemaining < minimumTlsDays) {
    throw new Error(
      `TLS certificate for ${url.hostname} has only ${daysRemaining} day(s) remaining`
    )
  }
  certificates.push({ host: url.hostname, expiresAt, daysRemaining })
}

const webResponse = await fetch(new URL("/", webUrl), {
  signal: AbortSignal.timeout(5000),
})
if (!webResponse.ok) throw new Error(`Web probe returned ${webResponse.status}`)
const requiredHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ],
  "strict-transport-security": ["max-age="],
  "x-content-type-options": ["nosniff"],
  "x-frame-options": ["DENY"],
  "referrer-policy": ["no-referrer"],
}
for (const [name, values] of Object.entries(requiredHeaders)) {
  const actual = webResponse.headers.get(name) ?? ""
  for (const value of values) {
    if (!actual.includes(value)) throw new Error(`Missing ${name}: ${value}`)
  }
}
if (webResponse.headers.has("x-powered-by")) {
  throw new Error("Web response exposes x-powered-by")
}

if (process.env.STAGING_SKIP_HTTP_REDIRECT !== "1") {
  const insecure = new URL(webUrl)
  insecure.protocol = "http:"
  insecure.port = process.env.STAGING_HTTP_PORT ?? ""
  const redirect = await fetch(insecure, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  })
  const location = redirect.headers.get("location")
  if (![301, 302, 307, 308].includes(redirect.status) || !location) {
    throw new Error("HTTP endpoint does not redirect to HTTPS")
  }
  const destination = new URL(location, insecure)
  if (destination.protocol !== "https:") {
    throw new Error("HTTP endpoint redirects to a non-HTTPS destination")
  }
}

for (const path of ["/health/live", "/health/ready"]) {
  const { response, payload } = await jsonProbe(new URL(path, apiUrl))
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`${path} returned an unhealthy response`)
  }
}

const unauthenticated = await fetch(new URL("/health/operations", apiUrl), {
  signal: AbortSignal.timeout(5000),
})
if (unauthenticated.status !== 401) {
  throw new Error(
    "Operations monitoring endpoint does not reject anonymous access"
  )
}
const { response: monitored, payload: operations } = await jsonProbe(
  new URL("/health/operations", apiUrl),
  { headers: { Authorization: `Bearer ${monitoringToken}` } }
)
if (!monitored.ok || operations?.ok !== true || !operations.exceptions) {
  throw new Error("Authenticated operational monitoring probe failed")
}

const authBoundary = await fetch(new URL("/api/auth/get-session", webUrl), {
  redirect: "manual",
  signal: AbortSignal.timeout(5000),
})
if (!authBoundary.ok) {
  throw new Error(`Web-to-auth proxy returned ${authBoundary.status}`)
}

console.log(
  JSON.stringify(
    {
      ok: true,
      webOrigin: webUrl.origin,
      apiOrigin: apiUrl.origin,
      certificates,
      readiness: "ok",
      authProxy: "ok",
      exceptionCounts: operations.exceptions,
      checkedAt: new Date(),
    },
    null,
    2
  )
)
