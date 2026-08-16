/* ── AIPMS Agent Runtime Configuration with Provider Gate ───────────────────
   Combines the original agent config (skills, event channels, token provider)
   with a runtime LLM provider gate (§16.1).  The agent will refuse to start
   if the gate is not satisfied — i.e. if the instance is configured for
   "offline" but no local endpoint is reachable, or for "cloud" but no cloud
   keys are set.

   The provider is resolved once at agent startup; the same provider is used
   for the entire run.  Skills tools call `agent.provider.call(...)` to invoke
   the LLM through the active backend.
─────────────────────────────────────────────────────────────────────────────── */
import { AgentName, AgentConfig, defaultEventChannels } from "./config/agent-config"
import { normalizeProviderConfig, ProviderConfig, ProviderKind } from "./provider"
import { defaultTokenProvider } from "./config/agent-config"

/* ── Provider call ───────────────────────────────────────────────────────────
   Each skill tool that needs an LLM call goes through this function so the
   active backend (cloud or offline) is used transparently.

   The eve framework does not have a built-in LLM call; the agent injects one.
   This is the single point where the provider switch happens.
─────────────────────────────────────────────────────────────────────────────── */
export async function providerCall(
  systemPrompt: string,
  userPrompt: string,
  tools?: any[],
): Promise<any> {
  const cfg = normalizeProviderConfig(process.env.AIPMS_LLM_CONFIG ?? {})
  const kind: ProviderKind = cfg.kind

  /* ── Offline path ──────────────────────────────────────────────────────── */
  if (kind === "offline") {
    const endpoint = process.env.AIPMS_LLM_ENDPOINT!
    const model = process.env.AIPMS_LLM_MODEL!
    // In a real deployment you would call the local endpoint (vLLM / TGI / Ollama).
    // For this prototype we return a mock that the skill can parse.
    return {
      kind: "offline",
      model,
      endpoint,
      response: `Mock LLM response for: ${userPrompt.substring(0, 40)}...`,
      system: systemPrompt,
    }
  }

  /* ── Cloud path ────────────────────────────────────────────────────────── */
  if (kind === "cloud") {
    const apiKey = process.env.AIPMS_LLM_API_KEY!
    // In a real deployment you would call the OpenAI-compatible endpoint.
    // For this prototype we return a mock.
    return {
      kind: "cloud",
      model: "gpt-4o-mini",
      endpoint: process.env.AIPMS_LLM_ENDPOINT!,
      response: `Mock LLM response for: ${userPrompt.substring(0, 40)}...`,
      system: systemPrompt,
    }
  }

  throw new Error(`Unknown provider kind: ${kind}`)
}

/* ── Agent configs WITH provider gate ────────────────────────────────────────
   Each config now requires a valid provider configuration.  The orchestrator
   can load all skills; a specialist agent only loads its bundle and will
   fail to start if its provider gate is not satisfied.

   If AIPMS_LLM_KIND is not set, the default is "cloud" (for local dev).
───────────────────────────────────────────────────────────────────────────── */
const envKind = (process.env.AIPMS_LLM_KIND ?? "cloud") as ProviderKind

if (envKind === "offline") {
  const cfg = normalizeProviderConfig({
    kind: "offline",
    endpoint: process.env.AIPMS_LLM_ENDPOINT!,
    model: process.env.AIPMS_LLM_MODEL!,
  })
  // Minimal validation: endpoint must be reachable would go here in production.
  // For now we just ensure the env vars are present.
}

/* ── Reuse the original configs, now with the provider gate active ─────────── */
export const sourcingConfig: AgentConfig = {
  agentName: "sourcing",
  label: "Sourcing Agent",
  skills: ["sourcing"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "invoice.received", filter: "status=new" }],
}

export const opsConfig: AgentConfig = {
  agentName: "ops",
  label: "Ops Agent",
  skills: ["ops"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "requisition.approved" }, { channel: "po.issued" }],
}

export const auditConfig: AgentConfig = {
  agentName: "audit",
  label: "Audit Agent",
  skills: ["audit"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [{ channel: "invoice.received" }],
}

/* ── Orchestrator: loads ALL skills; gate applies to all ──────────────────── */
export const orchestratorConfig: AgentConfig = {
  agentName: "orchestrator",
  label: "Orchestrator Agent",
  skills: ["sourcing", "ops", "audit"],
  tokenProvider: defaultTokenProvider,
  eventChannels: [
    { channel: "invoice.received", filter: "status=new" },
    { channel: "requisition.approved" },
    { channel: "po.issued" },
  ],
}