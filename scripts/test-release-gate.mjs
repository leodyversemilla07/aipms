#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "aipms-release-gate-"))
const evidencePath = join(directory, "evidence.json")
const manifestPath = join(directory, "manifest.json")
const sourceSha = "a".repeat(40)
const timestamp = new Date().toISOString()
const image = (name, character) =>
  `ghcr.io/example/aipms-${name}@sha256:${character.repeat(64)}`
const images = {
  api: image("api", "a"),
  web: image("web", "b"),
  agent: image("agent", "c"),
}
const record = (status = "passed") => ({
  status,
  owner: "release-owner",
  performedAt: timestamp,
  evidenceId: "CHG-1234",
})
const rotation = () => ({
  ...record(),
  oldCredentialRejected: true,
  newCredentialAccepted: true,
})
const evidence = {
  schemaVersion: 1,
  sourceSha,
  deployedImages: images,
  validations: {
    deploymentPreflight: record(),
    tlsAndSecurityBoundary: record(),
    smtpDeliveryAndRecovery: record(),
    imapIntake: record(),
    idpAndScim: record(),
    qboSandboxAndRecovery: record(),
    llmOcr: record("human-review-only"),
    paymentDestinationIsolation: record(),
    browserCapacity: record(),
    offHostBackupRestore: record(),
    alertRouting: record(),
    telemetryAggregation: record(),
    backupSchedulingAndReplication: record(),
  },
  rotations: Object.fromEntries(
    [
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
    ].map((name) => [name, rotation()])
  ),
  reviews: {
    taxAndBir: record(),
    signatureAndLegal: record("integrity-only"),
  },
}
const manifest = {
  sourceSha,
  version: `candidate-${sourceSha}`,
  images,
  sbom: true,
  provenance: "mode=max",
  sigstore: "verified",
}

try {
  writeFileSync(evidencePath, JSON.stringify(evidence))
  writeFileSync(manifestPath, JSON.stringify(manifest))
  execFileSync(process.execPath, [
    "scripts/release-gate.mjs",
    evidencePath,
    manifestPath,
  ])

  evidence.validations.offHostBackupRestore.status = "pending"
  writeFileSync(evidencePath, JSON.stringify(evidence))
  const rejected = spawnSync(process.execPath, [
    "scripts/release-gate.mjs",
    evidencePath,
    manifestPath,
  ])
  if (rejected.status === 0) {
    throw new Error("release gate accepted pending disaster-recovery evidence")
  }
  const output = `${rejected.stdout}${rejected.stderr}`
  if (!output.includes("validations.offHostBackupRestore")) {
    throw new Error("release gate did not identify the failed evidence record")
  }
  process.stdout.write("Release evidence gate self-test passed.\n")
} finally {
  rmSync(directory, { recursive: true, force: true })
}
