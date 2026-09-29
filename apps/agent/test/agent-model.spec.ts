import { afterEach, describe, expect, it, vi } from "vitest"
import { chatgpt } from "eve/models/openai"
import {
  assertProviderGate,
  buildModel,
  resolveProviderFromEnv,
} from "../agent/lib/provider"

vi.mock("eve", () => ({ defineAgent: (config: unknown) => config }))
vi.mock("eve/models/openai", () => ({
  chatgpt: vi.fn(() => "chatgpt-model"),
}))
vi.mock("../agent/lib/provider", () => ({
  resolveProviderFromEnv: vi.fn(() => ({ kind: "cloud" })),
  assertProviderGate: vi.fn(),
  buildModel: vi.fn(() => "api-model"),
  resolveContextWindowTokens: vi.fn(() => 128_000),
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.resetModules()
})

describe("agent model selection", () => {
  it("uses a ChatGPT subscription locally without requiring an API key", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("AIPMS_LLM_KIND", "chatgpt")
    const { default: agent } = await import("../agent/agent")
    expect(agent.model).toBe("chatgpt-model")
    expect(chatgpt).toHaveBeenCalledOnce()
    expect(resolveProviderFromEnv).not.toHaveBeenCalled()
  })

  it("rejects the subscription in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AIPMS_LLM_KIND", "chatgpt")
    await expect(import("../agent/agent")).rejects.toThrow(
      "AIPMS_LLM_KIND=chatgpt is local-development only"
    )
    expect(chatgpt).not.toHaveBeenCalled()
  })

  it("keeps the existing API-key provider path", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("AIPMS_LLM_KIND", "cloud")
    const { default: agent } = await import("../agent/agent")
    expect(agent.model).toBe("api-model")
    expect(resolveProviderFromEnv).toHaveBeenCalledOnce()
    expect(assertProviderGate).toHaveBeenCalledOnce()
    expect(buildModel).toHaveBeenCalledOnce()
    expect(chatgpt).not.toHaveBeenCalled()
  })
})
