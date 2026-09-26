#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const [evidenceArgument, manifestArgument] = process.argv.slice(2)
if (!evidenceArgument || !manifestArgument) {
  throw new Error(
    "Usage: node scripts/release-gate.mjs <release-evidence.json> <image-manifest.json>"
  )
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"))
}

const evidence = readJson(evidenceArgument)
const manifest = readJson(manifestArgument)
const failures = []
const maxAgeDays = Number.parseInt(
  process.env.RELEASE_EVIDENCE_MAX_AGE_DAYS ?? "90",
  10
)
const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
const now = Date.now()

function fail(path, message) {
  failures.push({ path, message })
}

function record(path, allowedStatuses = ["passed"]) {
  const value = path
    .split(".")
    .reduce((current, key) => current?.[key], evidence)
  if (!value || typeof value !== "object") {
    fail(path, "evidence record is required")
    return
  }
  if (!allowedStatuses.includes(value.status)) {
    fail(path, `status must be ${allowedStatuses.join(" or ")}`)
  }
  for (const field of ["owner", "performedAt", "evidenceId"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      fail(`${path}.${field}`, "is required")
    }
  }
  const timestamp = Date.parse(value.performedAt)
  if (!Number.isFinite(timestamp)) {
    fail(`${path}.performedAt`, "must be an ISO timestamp")
  } else if (timestamp > now + 5 * 60 * 1000) {
    fail(`${path}.performedAt`, "must not be in the future")
  } else if (now - timestamp > maxAgeMs) {
    fail(`${path}.performedAt`, `is older than ${maxAgeDays} days`)
  }
}

if (evidence.schemaVersion !== 1) fail("schemaVersion", "must equal 1")
if (!/^[0-9a-f]{40}$/.test(evidence.sourceSha ?? "")) {
  fail("sourceSha", "must be a full commit SHA")
}
if (evidence.sourceSha !== manifest.sourceSha) {
  fail("sourceSha", "does not match the immutable image manifest")
}
if (manifest.sigstore !== "verified") {
  fail("manifest.sigstore", "published signatures were not verified")
}
if (manifest.sbom !== true || manifest.provenance !== "mode=max") {
  fail("manifest", "SBOM and maximum provenance are required")
}
for (const component of ["api", "web", "agent"]) {
  const image = manifest.images?.[component]
  if (typeof image !== "string" || !/@sha256:[a-f0-9]{64}$/.test(image)) {
    fail(`manifest.images.${component}`, "must be pinned by sha256 digest")
  }
  if (evidence.deployedImages?.[component] !== image) {
    fail(
      `deployedImages.${component}`,
      "must exactly match the signed candidate manifest"
    )
  }
}

for (const name of [
  "deploymentPreflight",
  "tlsAndSecurityBoundary",
  "smtpDeliveryAndRecovery",
  "imapIntake",
  "idpAndScim",
  "qboSandboxAndRecovery",
  "paymentDestinationIsolation",
  "browserCapacity",
  "offHostBackupRestore",
  "alertRouting",
  "telemetryAggregation",
  "backupSchedulingAndReplication",
]) {
  record(`validations.${name}`)
}
record("validations.llmOcr", ["passed", "human-review-only"])
record("reviews.taxAndBir")
record("reviews.signatureAndLegal", ["passed", "integrity-only"])

for (const name of [
  "monitoring",
  "agentBootstrap",
  "agentSigning",
  "erpEnvelope",
  "betterAuth",
  "poSigning",
  "idp",
  "imap",
  "smtp",
  "qbo",
  "llm",
]) {
  const path = `rotations.${name}`
  record(path)
  const rotation = evidence.rotations?.[name]
  if (rotation?.oldCredentialRejected !== true) {
    fail(`${path}.oldCredentialRejected`, "must be true")
  }
  if (rotation?.newCredentialAccepted !== true) {
    fail(`${path}.newCredentialAccepted`, "must be true")
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, failureCount: failures.length, failures }, null, 2)}\n`
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        sourceSha: evidence.sourceSha,
        imageVersion: manifest.version,
        checkedAt: new Date().toISOString(),
        evidenceMaxAgeDays: maxAgeDays,
      },
      null,
      2
    )}\n`
  )
}
