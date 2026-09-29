import { defineAgent } from "eve"
import { chatgpt } from "eve/models/openai"
import {
  assertProviderGate,
  buildModel,
  resolveContextWindowTokens,
  resolveProviderFromEnv,
} from "./lib/provider"

function modelConfig() {
  if (process.env.AIPMS_LLM_KIND === "chatgpt") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AIPMS_LLM_KIND=chatgpt is local-development only")
    }
    // Subscription authentication is handled by eve's /login, not an API key.
    return { model: chatgpt() }
  }

  const provider = resolveProviderFromEnv(process.env)
  assertProviderGate(provider, process.env)
  return {
    model: buildModel(provider),
    modelContextWindowTokens: resolveContextWindowTokens(process.env),
  }
}

export default defineAgent(modelConfig())
