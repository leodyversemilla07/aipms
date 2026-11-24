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
const components = { api: sourceSha, web: sourceSha, agent: sourceSha }
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
  deployedComponents: components,
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
  deployment: "managed-processes",
  components,
}

function runGate() {
  return spawnSync(process.execPath, [
    "scripts/release-gate.mjs",
    evidencePath,
    manifestPath,
  ])
}

function writeFiles(nextEvidence = evidence, nextManifest = manifest) {
  writeFileSync(evidencePath, JSON.stringify(nextEvidence))
  writeFileSync(manifestPath, JSON.stringify(nextManifest))
}

try {
  writeFiles()
  execFileSync(process.execPath, [
    "scripts/release-gate.mjs",
    evidencePath,
    manifestPath,
  ])

  // A managed-process release must pin every component to the source SHA.
  writeFiles(evidence, {
    ...manifest,
    components: { ...components, web: "b".repeat(40) },
  })
  const unpinned = runGate()
  if (unpinned.status === 0) {
    throw new Error(
      "release gate accepted an unpinned managed-process component"
    )
  }
  if (
    !`${unpinned.stdout}${unpinned.stderr}`.includes("manifest.components.web")
  ) {
    throw new Error("release gate did not identify the unpinned component")
  }

  // The deployed evidence must match the signed candidate manifest.
  writeFiles({
    ...evidence,
    deployedComponents: { ...components, api: "c".repeat(40) },
  })
  const mismatch = runGate()
  if (mismatch.status === 0) {
    throw new Error("release gate accepted a mismatched deployed component")
  }
  if (
    !`${mismatch.stdout}${mismatch.stderr}`.includes("deployedComponents.api")
  ) {
    throw new Error("release gate did not identify the mismatched component")
  }

  // Container deployments keep digest, SBOM, provenance, and signature rules.
  writeFiles(
    { ...evidence, deployedComponents: undefined, deployedImages: images },
    {
      sourceSha,
      version: `candidate-${sourceSha}`,
      deployment: "containers",
      images,
      sbom: true,
      provenance: "mode=max",
      sigstore: "verified",
    }
  )
  execFileSync(process.execPath, [
    "scripts/release-gate.mjs",
    evidencePath,
    manifestPath,
  ])
  writeFiles(
    { ...evidence, deployedComponents: undefined, deployedImages: images },
    {
      sourceSha,
      version: `candidate-${sourceSha}`,
      deployment: "containers",
      images,
      sbom: false,
      provenance: "mode=max",
      sigstore: "verified",
    }
  )
  const unsigned = runGate()
  if (unsigned.status === 0) {
    throw new Error("release gate accepted a container release without an SBOM")
  }
  if (!`${unsigned.stdout}${unsigned.stderr}`.includes("SBOM")) {
    throw new Error("release gate did not identify the missing SBOM")
  }

  writeFiles()
  evidence.validations.offHostBackupRestore.status = "pending"
  writeFileSync(evidencePath, JSON.stringify(evidence))
  const rejected = runGate()
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
