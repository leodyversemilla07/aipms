import { generateText } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildModel } from "../agent/lib/provider"

afterEach(() => vi.unstubAllGlobals())

describe("OpenAI-compatible wire protocol", () => {
  it.each(["cloud", "offline"] as const)(
    "uses chat completions in %s mode",
    async (kind) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Ready" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      vi.stubGlobal("fetch", fetchMock)
      const model = buildModel(
        kind === "cloud"
          ? {
              kind,
              endpoint: "https://llm.example/v1",
              model: "test-model",
              apiKey: "test-only",
              organization: "test-org",
            }
          : { kind, endpoint: "http://localhost:11434/v1", model: "test-model" }
      )
      const result = await generateText({
        model,
        prompt: "Hello",
        maxRetries: 0,
      })
      expect(result.text).toBe("Ready")
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(String(url)).toBe(
        kind === "cloud"
          ? "https://llm.example/v1/chat/completions"
          : "http://localhost:11434/v1/chat/completions"
      )
      expect(JSON.parse(init.body as string)).toMatchObject({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
      })
      const headers = new Headers(init.headers)
      expect(headers.get("authorization")).toBe(
        kind === "cloud" ? "Bearer test-only" : "Bearer local"
      )
      if (kind === "cloud")
        expect(headers.get("OpenAI-Organization")).toBe("test-org")
    }
  )
})
