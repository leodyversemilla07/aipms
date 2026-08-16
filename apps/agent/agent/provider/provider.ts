/* ── AIPMS Agent LLM Provider Gate ─────────────────────────────────────────
   The agent can run with either a cloud LLM provider or an offline/local
   endpoint.  A "provider gate" at runtime decides which path to take based
   on the instance configuration (§16.1).  Both paths present the same tool
   surface (the tRPC procedures wrapped as eve skills); only the underlying
   model call changes.

   - Cloud:   BYO OpenAI/OpenAI-compatible keys (egress permitted).
   - Offline:  Local OpenAI-compatible endpoint (vLLM / TGI / Ollama) with
     zero egress.  Model weights stay inside the instance boundary.
   - Gate:    A per-instance config flag decides which path; the agent
     startup refuses to start if the gate is not satisfied.

   The provider interface is deliberately tiny so new backends can be added
   without touching the agent skill logic.
─────────────────────────────────────────────────────────────────────────────── */

import { z } from "zod"

/* ── Provider kind ─────────────────────────────────────────────────────────── */
export type ProviderKind = "cloud" | "offline"

/* ── Cloud provider config ─────────────────────────────────────────────────── */
export type CloudProviderConfig = {
  kind: "cloud"
  /** OpenAI-compatible endpoint URL (e.g. https://api.openai.com/v1) */
  endpoint: string
  /** API key (secret; never stored in repo). */
  apiKey: string
  /** Optional organization ID for multi-tenant clouds. */
  organization?: string
}

/* ── Offline provider config ─────────────────────────────────────────────── */
export type OfflineProviderConfig = {
  kind: "offline"
  /** OpenAI-compatible endpoint URL (e.g. http://localhost:1234/v1) */
  endpoint: string
  /** Model name as the local endpoint sees it (e.g. "meta-llama/Llama-3-8B"). */
  model: string
  /** Optional: system prompt that applies to all agent runs. */
  systemPrompt?: string
}

/* ── Instance-level provider config ───────────────────────────────────────── */
export type ProviderConfig = CloudProviderConfig | OfflineProviderConfig

/* ── Validation schemas ──────────────────────────────────────────────────── */
const cloudSchema = z.object({
  kind: z.literal("cloud"),
  endpoint: z.string().url(),
  apiKey: z.string().min(1),
  organization: z.string().optional(),
})

const offlineSchema = z.object({
  kind: z.literal("offline"),
  endpoint: z.string().url(),
  model: z.string().min(1),
  systemPrompt: z.string().optional(),
})

export type { ProviderKind, ProviderConfig, CloudProviderConfig, OfflineProviderConfig }
export const providerSchema = z.union([cloudSchema, offlineSchema])

/* ── Helper: coerce a partial config into a full ProviderConfig ────────────── */
export function normalizeProviderConfig(
  partial: Partial<ProviderConfig>,
): ProviderConfig {
  const result = providerSchema.safeParse(partial)
  if (!result.success) {
    throw new Error(
      `Invalid provider config: ${JSON.stringify(result.error.issues)}`,
    )
  }
  return result.data as ProviderConfig
}

/* ── Example: reading from env (the instance sets these at deploy time) ──────
   In production the env would be set by the Docker Compose / PaaS / offline
   bundle, never checked into source control.

   Example .env (cloud):
     AIPMS_LLM_ENDPOINT="https://api.openai.com/v1"
     AIPMS_LLM_API_KEY="sk-…"
     AIPMS_LLM_KIND="cloud"

   Example .env (offline):
     AIPMS_LLM_ENDPOINT="http://localhost:1234/v1"
     AIPMS_LLM_MODEL="meta-llama/Llama-3-8B"
     AIPMS_LLM_KIND="offline"
─────────────────────────────────────────────────────────────────────────────── */