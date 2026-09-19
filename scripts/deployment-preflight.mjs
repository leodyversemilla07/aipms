#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

function parseEnv(source) {
  const result = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line
    )
    if (!match) throw new Error(`Invalid environment line: ${rawLine}`)
    const key = match[1]
    let value = (match[2] ?? "").trim()
    const quote = value[0]
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length > 1
    ) {
      value = value.slice(1, -1)
    } else {
      const comment = value.indexOf(" #")
      if (comment >= 0) value = value.slice(0, comment).trim()
    }
    result[key] = value
  }
  return result
}

const envArgument = process.argv.slice(2).find((argument) => argument !== "--")
const envPath = resolve(envArgument ?? ".env")
const file = statSync(envPath)
if ((file.mode & 0o077) !== 0) {
  throw new Error(`${envPath} must not be readable or writable by group/others`)
}
const values = { ...parseEnv(readFileSync(envPath, "utf8")), ...process.env }
const errors = []
const warnings = []
const checks = []

function fail(check, message) {
  errors.push({ check, message })
}

function pass(check) {
  checks.push(check)
}

function required(name) {
  const value = values[name]?.trim()
  if (!value) fail(name, "is required")
  return value ?? ""
}

function secret(name, minimum = 32, optional = false) {
  const value = values[name]?.trim() ?? ""
  if (!value && optional) return ""
  if (!value) {
    fail(name, "is required")
    return ""
  }
  if (value.length < minimum)
    fail(name, `must contain at least ${minimum} characters`)
  if (
    /(change.?me|replace.?me|release-smoke|ci-only|your-token|password)/i.test(
      value
    )
  ) {
    fail(name, "looks like a placeholder")
  }
  return value
}

function httpsUrl(name, optional = false) {
  const raw = values[name]?.trim() ?? ""
  if (!raw && optional) return null
  if (!raw) {
    fail(name, "is required")
    return null
  }
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:") fail(name, "must use HTTPS")
    if (url.username || url.password) fail(name, "must not contain credentials")
    return url
  } catch {
    fail(name, "must be a valid URL")
    return null
  }
}

const appUrl = httpsUrl("APP_URL")
if (appUrl && (appUrl.pathname !== "/" || appUrl.search || appUrl.hash)) {
  fail("APP_URL", "must be an origin without a path, query, or fragment")
}
const trustedOrigins = required("AUTH_TRUSTED_ORIGINS")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
if (appUrl && !trustedOrigins.includes(appUrl.origin)) {
  fail("AUTH_TRUSTED_ORIGINS", "must include the exact APP_URL origin")
}
for (const origin of trustedOrigins) {
  try {
    if (new URL(origin).protocol !== "https:") {
      fail("AUTH_TRUSTED_ORIGINS", "must contain HTTPS origins only")
      break
    }
  } catch {
    fail("AUTH_TRUSTED_ORIGINS", "contains an invalid origin")
    break
  }
}

for (const name of ["POSTGRES_USER", "POSTGRES_DB"]) {
  const value =
    values[name]?.trim() || (name === "POSTGRES_USER" ? "user" : "aipms")
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail(name, "must be a safe PostgreSQL identifier")
  }
}
if (!/^[A-Za-z0-9._~-]+$/.test(values.POSTGRES_PASSWORD?.trim() ?? "")) {
  fail(
    "POSTGRES_PASSWORD",
    "must use URL-safe characters because Compose embeds it in DATABASE_URL"
  )
}

const secrets = new Map()
for (const [name, value] of [
  ["POSTGRES_PASSWORD", secret("POSTGRES_PASSWORD")],
  ["BETTER_AUTH_SECRET", secret("BETTER_AUTH_SECRET")],
  ["AIPMS_SERVICE_TOKEN", secret("AIPMS_SERVICE_TOKEN")],
  ["OPERATIONS_MONITORING_TOKEN", secret("OPERATIONS_MONITORING_TOKEN")],
  ["AIPMS_AGENT_ACCESS_TOKEN", secret("AIPMS_AGENT_ACCESS_TOKEN", 32, true)],
  [
    "AIPMS_SMTP_PASSWORD",
    values.AIPMS_SMTP_USER
      ? secret("AIPMS_SMTP_PASSWORD", 12)
      : secret("AIPMS_SMTP_PASSWORD", 12, true),
  ],
]) {
  if (!value) continue
  const prior = secrets.get(value)
  if (prior) fail(name, `must be independent from ${prior}`)
  else secrets.set(value, name)
}

if (![undefined, "", "0", "false"].includes(values.AUTH_SEED_DEMO)) {
  fail("AUTH_SEED_DEMO", "must be disabled outside development")
}
for (const name of [
  "POSTGRES_BIND_ADDRESS",
  "API_BIND_ADDRESS",
  "WEB_BIND_ADDRESS",
]) {
  const address = values[name]?.trim() || "127.0.0.1"
  if (["0.0.0.0", "::", "[::]"].includes(address)) {
    fail(name, "must not use a wildcard bind; use an intentional proxy network")
  }
}

const llmKind = values.AIPMS_LLM_KIND?.trim() || "cloud"
const llmEndpointRaw = values.AIPMS_LLM_ENDPOINT?.trim()
const llmModel = values.AIPMS_LLM_MODEL?.trim()
const allowedHosts = (values.AIPMS_LLM_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean)
const gatePolicies = (values.AIPMS_LLM_GATE ?? "")
  .split(",")
  .map((policy) => policy.trim().toLowerCase())
  .filter(Boolean)
for (const policy of gatePolicies) {
  if (!["residency", "retention", "no-retention"].includes(policy)) {
    fail("AIPMS_LLM_GATE", `contains unknown policy ${policy}`)
  }
}
if (llmKind === "cloud") {
  const key = values.AIPMS_LLM_API_KEY?.trim() || values.OPENAI_API_KEY?.trim()
  if (!key || key.length < 20)
    fail(
      "AIPMS_LLM_API_KEY",
      "cloud mode requires a non-placeholder provider key"
    )
  const endpoint = llmEndpointRaw
    ? httpsUrl("AIPMS_LLM_ENDPOINT")
    : new URL("https://api.openai.com/v1")
  if (gatePolicies.includes("residency") && endpoint) {
    if (!allowedHosts.includes(endpoint.hostname.toLowerCase())) {
      fail(
        "AIPMS_LLM_ALLOWED_HOSTS",
        "residency mode must allow the configured endpoint host"
      )
    }
  }
} else if (llmKind === "offline") {
  if (!llmEndpointRaw)
    fail("AIPMS_LLM_ENDPOINT", "offline mode requires an endpoint")
  if (!llmModel) fail("AIPMS_LLM_MODEL", "offline mode requires a model")
  if (llmEndpointRaw) {
    try {
      const endpoint = new URL(llmEndpointRaw)
      const host = endpoint.hostname.toLowerCase()
      const privateName =
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
      if (!privateName && !allowedHosts.includes(host)) {
        fail(
          "AIPMS_LLM_ALLOWED_HOSTS",
          "offline endpoint must be private or explicitly allowlisted"
        )
      }
    } catch {
      fail("AIPMS_LLM_ENDPOINT", "must be a valid URL")
    }
  }
} else {
  fail("AIPMS_LLM_KIND", 'must be "cloud" or "offline"')
}

const messageTransport = values.AIPMS_MESSAGING_TRANSPORT?.trim() || "smtp"
if (messageTransport !== "smtp") {
  fail(
    "AIPMS_MESSAGING_TRANSPORT",
    'production deployments must use the "smtp" transport'
  )
}
required("AIPMS_SMTP_HOST")
const smtpFrom = required("AIPMS_SMTP_FROM")
if (smtpFrom && !/@[^>\s]+>?$/.test(smtpFrom)) {
  fail("AIPMS_SMTP_FROM", "must contain an email address")
}
const smtpPort = Number(values.AIPMS_SMTP_PORT ?? 587)
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
  fail("AIPMS_SMTP_PORT", "must be an integer from 1 to 65535")
}
if (
  values.AIPMS_SMTP_SECURE &&
  !["true", "false"].includes(values.AIPMS_SMTP_SECURE)
) {
  fail("AIPMS_SMTP_SECURE", 'must be "true" or "false"')
}
if (Boolean(values.AIPMS_SMTP_USER) !== Boolean(values.AIPMS_SMTP_PASSWORD)) {
  fail("AIPMS_SMTP_USER/AIPMS_SMTP_PASSWORD", "must be configured together")
}
if (
  values.AIPMS_SMTP_MESSAGE_DOMAIN &&
  !/^[a-z0-9.-]+$/i.test(values.AIPMS_SMTP_MESSAGE_DOMAIN)
) {
  fail("AIPMS_SMTP_MESSAGE_DOMAIN", "must be a DNS name")
}

for (const group of [
  ["AIPMS_IMAP_HOST", "AIPMS_IMAP_USER", "AIPMS_IMAP_PASSWORD"],
  ["AIPMS_PAYMENT_DEBTOR_NAME", "AIPMS_PAYMENT_DEBTOR_ACCOUNT"],
  ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET"],
]) {
  const configured = group.filter((name) => values[name]?.trim())
  if (configured.length > 0 && configured.length !== group.length) {
    fail(group.join("/"), "must be configured completely or left disabled")
  }
}
if (values.AIPMS_IMAP_HOST && values.AIPMS_IMAP_TLS === "false") {
  fail("AIPMS_IMAP_TLS", "must not disable transport security in production")
}
if (
  values.QBO_ENVIRONMENT &&
  !["sandbox", "production"].includes(values.QBO_ENVIRONMENT)
) {
  fail("QBO_ENVIRONMENT", 'must be "sandbox" or "production"')
}
if (values.QBO_REDIRECT_URI) httpsUrl("QBO_REDIRECT_URI")

if (errors.length === 0) {
  for (const check of [
    "secure-env-file",
    "https-origins",
    "independent-secrets",
    "non-demo-identity",
    "loopback-bindings",
    "llm-provider-gate",
    "smtp-transport",
    "integration-pairs",
  ]) {
    pass(check)
  }
}
if (!values.AIPMS_SIGNING_KEYS_DIR) {
  warnings.push(
    "Qualified PO signing is disabled because AIPMS_SIGNING_KEYS_DIR is unset"
  )
}
if (!values.QBO_CLIENT_ID) warnings.push("QBO integration is disabled")
if (!values.AIPMS_IMAP_HOST) warnings.push("IMAP intake is disabled")

const report = {
  ok: errors.length === 0,
  environmentFile: envPath,
  checks,
  warnings,
  errors,
  checkedAt: new Date(),
}
console.log(JSON.stringify(report, null, 2))
if (errors.length > 0) process.exitCode = 1
