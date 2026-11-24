import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("agent tRPC token exchange", () => {
  it("uses and caches the short-lived production bearer", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AIPMS_API_URL", "https://api.example.com")
    vi.stubEnv("AIPMS_SERVICE_TOKEN", "bootstrap-secret")
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "scoped-access-token",
            expiresAt,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      )
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ result: { data: { json: { ok: true } } } }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    vi.stubGlobal("fetch", fetchMock)

    const { trpcQuery } = await import("../agent/lib/trpc-client")
    await expect(trpcQuery("catalog", "list", {})).resolves.toEqual({
      ok: true,
    })
    await expect(trpcQuery("catalog", "list", {})).resolves.toEqual({
      ok: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/service/agent/token"
    )
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: "Bearer scoped-access-token" },
    })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: { authorization: "Bearer scoped-access-token" },
    })
  })

  it("mints a scoped bearer per eve session", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AIPMS_API_URL", "https://api.example.com")
    vi.stubEnv("AIPMS_SERVICE_TOKEN", "bootstrap-secret")
    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    let exchanges = 0
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        if (String(input).endsWith("/api/service/agent/token")) {
          exchanges += 1
          return new Response(
            JSON.stringify({
              accessToken: exchanges === 1 ? "scoped-a" : "scoped-b",
              expiresAt,
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          )
        }
        return new Response(
          JSON.stringify({ result: { data: { json: { ok: true } } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      })
    vi.stubGlobal("fetch", fetchMock)

    const { defineTool } = await import("eve/tools")
    const { z } = await import("zod")
    const { defineAipmsTool } = await import("../agent/lib/agent-tool")
    const { trpcQuery } = await import("../agent/lib/trpc-client")
    const tool = defineAipmsTool(
      defineTool({
        description: "reads the catalog",
        inputSchema: z.object({}),
        async execute() {
          await trpcQuery("catalog", "list", {})
          return true
        },
      })
    )

    await tool.execute({}, { session: { id: "wrun_a" } } as never)
    await tool.execute({}, { session: { id: "wrun_b" } } as never)

    const exchangeBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith("/api/service/agent/token"))
      .map((call) => JSON.parse(String(call[1]?.body)))
    expect(exchangeBodies).toEqual([{ runId: "wrun_a" }, { runId: "wrun_b" }])
  })

  it("fails closed when token exchange fails", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("AIPMS_API_URL", "https://api.example.com")
    vi.stubEnv("AIPMS_SERVICE_TOKEN", "bootstrap-secret")
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("denied", { status: 401 }))
    )

    const { trpcQuery } = await import("../agent/lib/trpc-client")
    await expect(trpcQuery("catalog", "list", {})).rejects.toThrow(
      "Agent token exchange failed (401)"
    )
  })
})
