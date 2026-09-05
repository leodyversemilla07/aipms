import { beforeEach, describe, expect, it, vi } from "vitest"
import { trpcMutate } from "../agent/lib/trpc-client"
import {
  describeMessage,
  quoteInput,
  requestQuote,
  submitVendorMessage,
} from "../agent/lib/vendor-message"

vi.mock("../agent/lib/trpc-client", () => ({ trpcMutate: vi.fn() }))
const response = {
  message: { id: "message", tier: "gated" as const, status: "queued" as const },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(trpcMutate).mockResolvedValue(response)
})
const input = {
  vendorId: "vendor",
  recipient: "vendor@example.com",
  catalogItemSku: "SKU-1",
  quantity: 2,
}
describe("vendor messaging contract", () => {
  it("uses tRPC with a verified-recipient field and no client-selected tier", async () => {
    await requestQuote(input, "call")
    expect(trpcMutate).toHaveBeenCalledWith(
      "messaging",
      "submit",
      expect.objectContaining({
        recipient: input.recipient,
        templateId: "rfq",
        idempotencyKey: "eve:messaging.submit:call",
      })
    )
    expect(vi.mocked(trpcMutate).mock.calls[0]?.[2]).not.toHaveProperty("tier")
  })
  it("gates arbitrary notes rather than labelling them transactional", async () => {
    await requestQuote(
      { ...input, notes: "Additional commercial terms" },
      "call"
    )
    expect(vi.mocked(trpcMutate).mock.calls[0]?.[2].templateId).toBeUndefined()
  })
  it("preserves replay keys and explicit keys", async () => {
    await requestQuote(input, "call")
    await requestQuote(input, "call")
    expect(vi.mocked(trpcMutate).mock.calls[0]).toEqual(
      vi.mocked(trpcMutate).mock.calls[1]
    )
    await requestQuote({ ...input, idempotencyKey: "explicit" }, "call")
    expect(vi.mocked(trpcMutate).mock.calls[2]?.[2].idempotencyKey).toBe(
      "explicit"
    )
  })
  it("does not claim that a queued message was sent", () => {
    expect(describeMessage(response)).toContain("not sent")
  })
  it("requires a recipient and defaults quantity", () => {
    expect(() =>
      quoteInput.parse({ vendorId: "v", catalogItemSku: "s" })
    ).toThrow()
    expect(quoteInput.parse({ ...input, quantity: undefined }).quantity).toBe(1)
  })
  it("rejects malformed API responses and oversized bodies", async () => {
    vi.mocked(trpcMutate).mockResolvedValue({ ok: true })
    await expect(requestQuote(input, "call")).rejects.toThrow()
    await expect(
      submitVendorMessage(
        {
          vendorId: "v",
          recipient: input.recipient,
          subject: "s",
          body: "x".repeat(20001),
        },
        "call"
      )
    ).rejects.toThrow()
  })
})
