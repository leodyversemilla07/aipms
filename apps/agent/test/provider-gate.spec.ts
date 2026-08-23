import { describe, expect, it } from "vitest"
import {
  assertProviderGate,
  buildModel,
  DEFAULT_CLOUD_ENDPOINT,
  DEFAULT_CLOUD_MODEL,
  normalizeProviderConfig,
  parseGatePolicies,
  resolveContextWindowTokens,
  resolveProviderFromEnv,
} from "../agent/provider/provider"

function env(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    AIPMS_LLM_KIND: "cloud",
    AIPMS_LLM_ENDPOINT: "https://api.openai.com/v1",
    AIPMS_LLM_MODEL: "gpt-4o-mini",
    AIPMS_LLM_API_KEY: "sk-test",
    ...overrides,
  }
}

describe("resolveProviderFromEnv", () => {
  it("defaults to cloud with the OpenAI-compatible endpoint and model", () => {
    const cfg = resolveProviderFromEnv({})
    expect(cfg).toEqual({
      kind: "cloud",
      endpoint: DEFAULT_CLOUD_ENDPOINT,
      model: DEFAULT_CLOUD_MODEL,
      apiKey: undefined,
    })
  })

  it("resolves an offline provider from env", () => {
    const cfg = resolveProviderFromEnv({
      AIPMS_LLM_KIND: "offline",
      AIPMS_LLM_ENDPOINT: "http://localhost:1234/v1",
      AIPMS_LLM_MODEL: "meta-llama/Llama-3-8B",
    })
    expect(cfg).toEqual({
      kind: "offline",
      endpoint: "http://localhost:1234/v1",
      model: "meta-llama/Llama-3-8B",
    })
  })

  it("falls back to OPENAI_API_KEY for the cloud key", () => {
    const cfg = resolveProviderFromEnv({ OPENAI_API_KEY: "sk-openai" })
    expect(cfg.kind).toBe("cloud")
    expect(cfg.kind === "cloud" && cfg.apiKey).toBe("sk-openai")
  })

  it("rejects an unknown AIPMS_LLM_KIND", () => {
    expect(() => resolveProviderFromEnv({ AIPMS_LLM_KIND: "hybrid" })).toThrow(
      /Invalid AIPMS_LLM_KIND "hybrid"/
    )
  })

  it("treats empty-string env values as unset (compose defaults)", () => {
    const cfg = resolveProviderFromEnv({
      AIPMS_LLM_KIND: "cloud",
      AIPMS_LLM_ENDPOINT: "",
      AIPMS_LLM_MODEL: "",
      AIPMS_LLM_API_KEY: "dev-only-key-change-me",
    })
    expect(cfg).toEqual({
      kind: "cloud",
      endpoint: DEFAULT_CLOUD_ENDPOINT,
      model: DEFAULT_CLOUD_MODEL,
      apiKey: "dev-only-key-change-me",
    })
  })

  it("rejects an offline provider without a model", () => {
    expect(() =>
      resolveProviderFromEnv({
        AIPMS_LLM_KIND: "offline",
        AIPMS_LLM_ENDPOINT: "http://localhost:1234/v1",
      })
    ).toThrow(/Invalid provider config/)
  })
})

describe("parseGatePolicies", () => {
  it("defaults to no declared policies", () => {
    expect(parseGatePolicies(undefined)).toEqual({
      residency: false,
      retention: false,
      noRetention: false,
    })
  })

  it("parses a comma-separated policy list", () => {
    expect(parseGatePolicies("residency, no-retention")).toEqual({
      residency: true,
      retention: false,
      noRetention: true,
    })
  })

  it("rejects unknown policy names so typos cannot weaken the gate", () => {
    expect(() => parseGatePolicies("residensy")).toThrow(
      /Unknown AIPMS_LLM_GATE policy: residensy/
    )
  })
})

describe("assertProviderGate", () => {
  it("accepts an offline provider on a loopback endpoint", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "offline",
          endpoint: "http://localhost:11434/v1",
          model: "llama3.2:3b",
        }),
        env({ AIPMS_LLM_KIND: "offline" })
      )
    ).not.toThrow()
  })

  it.each([
    "http://10.0.0.5:8080/v1",
    "http://192.168.1.20:1234/v1",
    "http://172.16.3.9:8000/v1",
    "http://llm.internal:11434/v1",
    "http://llm.local:11434/v1",
  ])("accepts an offline provider on private host %s", (endpoint) => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "offline",
          endpoint,
          model: "qwen2.5:7b",
        }),
        env({ AIPMS_LLM_KIND: "offline" })
      )
    ).not.toThrow()
  })

  it("refuses an offline provider on a public LLM host (zero egress)", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "offline",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        }),
        env({ AIPMS_LLM_KIND: "offline" })
      )
    ).toThrow(/zero egress/)
  })

  it("allows an offline provider on a public host that is explicitly allowlisted", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "offline",
          endpoint: "https://llm.example-corp.com/v1",
          model: "llama3.2:3b",
        }),
        env({
          AIPMS_LLM_KIND: "offline",
          AIPMS_LLM_ALLOWED_HOSTS: "llm.example-corp.com",
        })
      )
    ).not.toThrow()
  })

  it("requires a key for the cloud provider", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "cloud",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        }),
        env({ AIPMS_LLM_API_KEY: undefined, OPENAI_API_KEY: undefined })
      )
    ).toThrow(/requires AIPMS_LLM_API_KEY/)
  })

  it("accepts a cloud provider with a key", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "cloud",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-test",
        }),
        env()
      )
    ).not.toThrow()
  })

  it("requires an allowlist when the residency gate is declared", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "cloud",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-test",
        }),
        env({ AIPMS_LLM_GATE: "residency" })
      )
    ).toThrow(/requires AIPMS_LLM_ALLOWED_HOSTS/)
  })

  it("refuses a cloud host outside the residency allowlist", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "cloud",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-test",
        }),
        env({
          AIPMS_LLM_GATE: "residency",
          AIPMS_LLM_ALLOWED_HOSTS: "api.azure.com",
        })
      )
    ).toThrow(/does not allow endpoint host "api.openai.com"/)
  })

  it("accepts a cloud host inside the residency allowlist", () => {
    expect(() =>
      assertProviderGate(
        normalizeProviderConfig({
          kind: "cloud",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-test",
        }),
        env({
          AIPMS_LLM_GATE: "residency",
          AIPMS_LLM_ALLOWED_HOSTS: "api.openai.com",
        })
      )
    ).not.toThrow()
  })
})

describe("resolveContextWindowTokens", () => {
  it("defaults to 128000 when unset", () => {
    expect(resolveContextWindowTokens({})).toBe(128_000)
  })

  it("reads an explicit context window", () => {
    expect(
      resolveContextWindowTokens({ AIPMS_LLM_CONTEXT_WINDOW: "8192" })
    ).toBe(8192)
  })

  it("rejects a non-positive value", () => {
    expect(() =>
      resolveContextWindowTokens({ AIPMS_LLM_CONTEXT_WINDOW: "-5" })
    ).toThrow(/Invalid AIPMS_LLM_CONTEXT_WINDOW/)
  })
})

describe("buildModel", () => {
  it("builds a LanguageModel for the offline provider", () => {
    const model = buildModel(
      normalizeProviderConfig({
        kind: "offline",
        endpoint: "http://localhost:11434/v1",
        model: "llama3.2:3b",
      })
    )
    expect(model).toMatchObject({ modelId: "llama3.2:3b" })
  })

  it("builds a LanguageModel for the cloud provider", () => {
    const model = buildModel(
      normalizeProviderConfig({
        kind: "cloud",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
      })
    )
    expect(model).toMatchObject({ modelId: "gpt-4o-mini" })
  })
})
