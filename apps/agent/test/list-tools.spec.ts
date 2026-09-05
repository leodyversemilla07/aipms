import { beforeEach, describe, expect, it, vi } from "vitest"
import { fetchList, listToolInput } from "../agent/lib/list-tool"
import { trpcQuery } from "../agent/lib/trpc-client"

vi.mock("../agent/lib/trpc-client", () => ({ trpcQuery: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

describe("paginated list tools", () => {
  it.each(["catalog", "vendor", "budget"] as const)(
    "uses the %s tRPC list contract",
    async (router) => {
      const response = { rows: [{ id: "item", limitMinor: 12345 }], total: 50 }
      vi.mocked(trpcQuery).mockResolvedValue(response)
      const input = listToolInput.parse({ q: "test", page: 2 })
      expect(await fetchList(router, input)).toEqual(response)
      expect(trpcQuery).toHaveBeenCalledWith(router, "list", {
        q: "test",
        page: 2,
        pageSize: 25,
      })
    }
  )
  it("rejects malformed results rather than reporting a false empty list", async () => {
    vi.mocked(trpcQuery).mockResolvedValue({ items: [] })
    await expect(fetchList("vendor", listToolInput.parse({}))).rejects.toThrow()
  })
  it("propagates authentication failures", async () => {
    vi.mocked(trpcQuery).mockRejectedValue(new Error("Unauthorized"))
    await expect(fetchList("budget", listToolInput.parse({}))).rejects.toThrow(
      "Unauthorized"
    )
  })
  it("validates pagination", () => {
    expect(() => listToolInput.parse({ page: 0 })).toThrow()
    expect(() => listToolInput.parse({ pageSize: 101 })).toThrow()
  })
})
