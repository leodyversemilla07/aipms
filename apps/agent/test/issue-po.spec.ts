import { beforeEach, describe, expect, it, vi } from "vitest"
import { describePoResult, issuePo } from "../agent/lib/issue-po"
import { trpcMutate } from "../agent/lib/trpc-client"

vi.mock("../agent/lib/trpc-client", () => ({ trpcMutate: vi.fn() }))

const input = { requisitionId: "req", vendorId: "vendor" }
const gated = { outcome: "NEED_APPROVAL" as const, ...input }
beforeEach(() => {
  vi.clearAllMocks()
})

describe("PO tool contract", () => {
  it("reports approval without claiming issuance", async () => {
    vi.mocked(trpcMutate).mockResolvedValue(gated)
    expect(describePoResult(await issuePo(input, "call-1"))).toContain(
      "No PO was issued"
    )
  })
  it("uses nested PO data and integer minor units", async () => {
    vi.mocked(trpcMutate).mockResolvedValue({
      outcome: "ISSUED",
      purchaseOrder: {
        id: "po",
        poNumber: "PO-1",
        status: "issued",
        totalMinor: 12345,
        currencyCode: "PHP",
        vendorId: "vendor",
      },
    })
    const text = describePoResult(await issuePo(input, "call-1"))
    expect(text).toContain("PO-1")
    expect(text).toContain("12345 minor units PHP")
    expect(text).not.toContain("undefined")
  })
  it("reuses the same fallback key for replayed calls", async () => {
    vi.mocked(trpcMutate).mockResolvedValue(gated)
    await issuePo(input, "same-call")
    await issuePo(input, "same-call")
    expect(vi.mocked(trpcMutate).mock.calls[0]).toEqual(
      vi.mocked(trpcMutate).mock.calls[1]
    )
    expect(trpcMutate).toHaveBeenCalledWith("purchaseOrder", "issue", {
      ...input,
      idempotencyKey: "eve:purchaseOrder.issue:same-call",
    })
  })
  it("preserves explicit keys", async () => {
    vi.mocked(trpcMutate).mockResolvedValue(gated)
    await issuePo({ ...input, idempotencyKey: "caller-key" }, "call")
    expect(trpcMutate).toHaveBeenCalledWith("purchaseOrder", "issue", {
      ...input,
      idempotencyKey: "caller-key",
    })
  })
  it("rejects malformed responses instead of fabricating success", async () => {
    vi.mocked(trpcMutate).mockResolvedValue({ outcome: "ISSUED" })
    await expect(issuePo(input, "call")).rejects.toThrow()
  })
  it("propagates backend errors", async () => {
    vi.mocked(trpcMutate).mockRejectedValue(new Error("Budget overrun"))
    await expect(issuePo(input, "call")).rejects.toThrow("Budget overrun")
  })
})
