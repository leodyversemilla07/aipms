import { describe, expect, it } from "vitest"
import batch from "../agent/tools/run_agent_batch"

describe("deterministic batch model summary", () => {
  it("reports quota deferral instead of suggesting the queue was drained", () => {
    const output = batch.toModelOutput?.({
      ok: true,
      documents: 3,
      succeeded: 1,
      failed: [],
      deferred: 2,
      quotaLimited: true,
    })
    expect(output).toMatchObject({
      type: "text",
      value: expect.stringContaining("2 deferred by quota"),
    })
    expect(output).toMatchObject({
      value: expect.stringContaining("queue is not drained"),
    })
  })
  it("preserves ordinary counts and failures for complete batches", () => {
    expect(
      batch.toModelOutput?.({
        ok: true,
        documents: 3,
        succeeded: 2,
        failed: [{ docId: "doc", error: "review needed" }],
        deferred: 0,
        quotaLimited: false,
      })
    ).toEqual({
      type: "text",
      value: "Processed 2/3 pending intake documents; 1 failed",
    })
  })
})
