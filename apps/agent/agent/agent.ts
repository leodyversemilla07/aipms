import { defineAgent } from "eve"
import {
  assertProviderGate,
  buildModel,
  resolveContextWindowTokens,
  resolveProviderFromEnv,
} from "./provider/provider"

const provider = resolveProviderFromEnv(process.env)
assertProviderGate(provider, process.env)

export default defineAgent({
  model: buildModel(provider),
  modelContextWindowTokens: resolveContextWindowTokens(process.env),
})