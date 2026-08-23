/* ── AIPMS Agent LLM Provider Gate ─────────────────────────────────────────
   The agent can run with either a cloud LLM provider (BYO keys) or an
   offline/local OpenAI-compatible endpoint with zero egress (§16.1, §16.2.1).
   A "provider gate" decides which path to take from instance configuration and
   refuses to start when the gate is not satisfied (§16.6).  Both paths present
   the same tool surface (the tRPC procedures wrapped as eve skills); only the
   underlying model call changes.

   - Cloud:   BYO OpenAI/OpenAI-compatible keys (egress permitted).
   - Offline: Local OpenAI-compatible endpoint (vLLM / TGI / Ollama) inside the
     instance boundary with zero egress; model weights stay in-boundary.
   - Gate:    `AIPMS_LLM_GATE` declares residency / retention / no-retention
     policies; offline mode satisfies them by construction, cloud mode must
     satisfy the residency allowlist.

   The provider interface is deliberately tiny so new backends can be added
   without touching the agent skill logic.
────────────────────────────────────────────────────────────────────────────── */

import { createGateway, type LanguageModel } from "ai"
import { z } from "zod"

/* ── Provider kind ─────────────────────────────────────────────────────────── */
export type ProviderKind = "cloud" | "offline"

/* ── Cloud provider config ─────────────────────────────────────────────────── */
export type CloudProviderConfig = {
  kind: "cloud"
  /** OpenAI-compatible endpoint URL (e.g. https://api.openai.com/v1). */
  endpoint: string
  /** API key (secret; never stored in repo). */
  apiKey: string
  /** Model id as the endpoint expects it (e.g. "gpt-4o-mini"). */
  model: string
  /** Optional organization ID for multi-tenant clouds. */
  organization?: string
}

/* ── Offline provider config ───────────────────────────────────────────────── */
export type OfflineProviderConfig = {
  kind: "offline"
  /** OpenAI-compatible endpoint URL (e.g. http://localhost:1234/v1). */
  endpoint: string
  /** Model name as the local endpoint sees it (e.g. "meta-llama/Llama-3-8B"). */
  model: string
  /** Optional: system prompt that applies to all agent runs. */
  systemPrompt?: string
}

export type ProviderConfig = CloudProviderConfig | OfflineProviderConfig

/* ── Validation schemas ──────────────────────────────────────────────────── */
const cloudSchema = z.object({
  kind: z.literal("cloud"),
  endpoint: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  organization: z.string().optional(),
})

const offlineSchema = z.object({
  kind: z.literal("offline"),
  endpoint: z.string().url(),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
})

export const providerSchema = z.union([cloudSchema, offlineSchema])

/* ── Helper: coerce a partial config into a full ProviderConfig ────────────── */
export function normalizeProviderConfig(
  partial: Partial<ProviderConfig>
): ProviderConfig {
  const result = providerSchema.safeParse(partial)
  if (!result.success) {
    throw new Error(
      `Invalid provider config: ${JSON.stringify(result.error.issues)}`
    )
  }
  return result.data as ProviderConfig
}

/* ── Gate policies ──────────────────────────────────────────────────────────
   AIPMS_LLM_GATE is a comma-separated list of policies the instance declares
   it honors.  Unknown names are a config error so a typo cannot silently
   weaken the gate.
────────────────────────────────────────────────────────────────────────────── */
export type GatePolicies = {
  residency: boolean
  retention: boolean
  noRetention: boolean
}

export const GATE_POLICY_NAMES = [
  "residency",
  "retention",
  "no-retention",
] as const

export function parseGatePolicies(raw: string | undefined): GatePolicies {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const unknown = names.filter(
    (n) => !GATE_POLICY_NAMES.includes(n as (typeof GATE_POLICY_NAMES)[number])
  )
  if (unknown.length > 0) {
    throw new Error(
      `Unknown AIPMS_LLM_GATE policy: ${unknown.join(", ")}. ` +
        `Allowed policies: ${GATE_POLICY_NAMES.join(", ")}.`
    )
  }
  return {
    residency: names.includes("residency"),
    retention: names.includes("retention"),
    noRetention: names.includes("no-retention"),
  }
}

/* ── Defaults ────────────────────────────────────────────────────────────── */
export const DEFAULT_CLOUD_ENDPOINT = "https://api.openai.com/v1"
export const DEFAULT_CLOUD_MODEL = "gpt-4o-mini"
export const OFFLINE_API_KEY = "local"
/** Fallback context window for custom endpoints eve cannot resolve via the
    AI Gateway catalog. Tune per model via AIPMS_LLM_CONTEXT_WINDOW. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

export function resolveContextWindowTokens(
  env: Record<string, string | undefined>
): number {
  const raw = env.AIPMS_LLM_CONTEXT_WINDOW
  if (raw === undefined || raw === "") return DEFAULT_CONTEXT_WINDOW
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Invalid AIPMS_LLM_CONTEXT_WINDOW "${raw}". Expected a positive integer.`
    )
  }
  return n
}

/* ── Resolve the provider from the instance environment ────────────────────
   AIPMS_LLM_KIND   "cloud" (default) | "offline"
   AIPMS_LLM_ENDPOINT  OpenAI-compatible base URL
   AIPMS_LLM_MODEL     model id
   AIPMS_LLM_API_KEY   cloud key (falls back to OPENAI_API_KEY)
   AIPMS_LLM_GATE      comma-separated residency/retention/no-retention
   AIPMS_LLM_ALLOWED_HOSTS  comma-separated host allowlist for the residency gate
────────────────────────────────────────────────────────────────────────────── */
function firstDefined(
  ...values: Array<string | undefined>
): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== "") return v
  }
  return undefined
}

export function resolveProviderFromEnv(
  env: Record<string, string | undefined>
): ProviderConfig {
  const kind = firstDefined(env.AIPMS_LLM_KIND) ?? "cloud"

  if (kind === "offline") {
    return normalizeProviderConfig({
      kind: "offline",
      endpoint: env.AIPMS_LLM_ENDPOINT,
      model: env.AIPMS_LLM_MODEL,
    })
  }

  if (kind !== "cloud") {
    throw new Error(
      `Invalid AIPMS_LLM_KIND "${kind}". Expected "cloud" or "offline".`
    )
  }

  return normalizeProviderConfig({
    kind: "cloud",
    endpoint: firstDefined(env.AIPMS_LLM_ENDPOINT) ?? DEFAULT_CLOUD_ENDPOINT,
    model: firstDefined(env.AIPMS_LLM_MODEL) ?? DEFAULT_CLOUD_MODEL,
    apiKey: firstDefined(env.AIPMS_LLM_API_KEY, env.OPENAI_API_KEY),
  })
}

/* ── Host classification (zero-egress enforcement) ───────────────────────── */
function _isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h === "::1") return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  return m[1] === "127"
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "localhost" || h === "::1") return true
  if (h.endsWith(".local") || h.endsWith(".internal")) return true
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  )
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/* ── The provider gate ──────────────────────────────────────────────────────
   Throws when the instance configuration does not satisfy the gate, so the
   agent refuses to start (§16.6).  Offline mode satisfies residency /
   retention / no-retention by construction and is additionally required to
   point at a private/local endpoint (zero egress).  Cloud mode must carry a
   key and, when residency is declared, an explicit host allowlist.
────────────────────────────────────────────────────────────────────────────── */
export function assertProviderGate(
  cfg: ProviderConfig,
  env: Record<string, string | undefined>
): void {
  const gate = parseGatePolicies(env.AIPMS_LLM_GATE)
  const allowedHosts = parseAllowedHosts(env.AIPMS_LLM_ALLOWED_HOSTS)
  const host = new URL(cfg.endpoint).hostname.toLowerCase()

  if (cfg.kind === "offline") {
    if (!isPrivateHost(host) && !allowedHosts.includes(host)) {
      throw new Error(
        `AIPMS_LLM_KIND=offline requires a private/local endpoint (zero egress), ` +
          `got "${host}". Add it to AIPMS_LLM_ALLOWED_HOSTS to override.`
      )
    }
    return
  }

  if (!cfg.apiKey) {
    throw new Error(
      "AIPMS_LLM_KIND=cloud requires AIPMS_LLM_API_KEY (or OPENAI_API_KEY)."
    )
  }

  if (gate.residency) {
    if (allowedHosts.length === 0) {
      throw new Error(
        "The residency gate requires AIPMS_LLM_ALLOWED_HOSTS to be set."
      )
    }
    if (!allowedHosts.includes(host)) {
      throw new Error(
        `The residency gate does not allow endpoint host "${host}". ` +
          `Add it to AIPMS_LLM_ALLOWED_HOSTS or remove the residency policy.`
      )
    }
  }
}

/* ── Build the eve LanguageModel for the resolved provider ─────────────────
   Both paths use an OpenAI-compatible client (createGateway with an explicit
   baseURL and apiKey); only the endpoint, model, and credential differ.
────────────────────────────────────────────────────────────────────────────── */
export function buildModel(cfg: ProviderConfig): LanguageModel {
  const apiKey = cfg.kind === "offline" ? OFFLINE_API_KEY : cfg.apiKey
  const provider = createGateway({
    baseURL: cfg.endpoint,
    apiKey,
  })
  return provider(cfg.model)
}

/* ── Example: reading from env (the instance sets these at deploy time) ──────
   In production the env would be set by the Docker Compose / PaaS / offline
   bundle, never checked into source control.

   Example .env (cloud):
     AIPMS_LLM_KIND="cloud"
     AIPMS_LLM_ENDPOINT="https://api.openai.com/v1"
     AIPMS_LLM_MODEL="gpt-4o-mini"
     AIPMS_LLM_API_KEY="sk-…"

   Example .env (offline, zero egress):
     AIPMS_LLM_KIND="offline"
     AIPMS_LLM_ENDPOINT="http://localhost:1234/v1"
     AIPMS_LLM_MODEL="meta-llama/Llama-3-8B"

   Example .env (offline with residency + no-retention declared):
     AIPMS_LLM_KIND="offline"
     AIPMS_LLM_ENDPOINT="http://llm:11434/v1"
     AIPMS_LLM_MODEL="llama3.2:3b"
     AIPMS_LLM_GATE="residency,no-retention"
────────────────────────────────────────────────────────────────────────────── */
