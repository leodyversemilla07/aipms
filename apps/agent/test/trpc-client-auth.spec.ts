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
      .mockResolvedValue(
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
