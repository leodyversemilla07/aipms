import { defineTool } from "eve/tools"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { currentAgentRunId, defineAipmsTool } from "../agent/lib/agent-tool"

/**
 * §7.1 — every agent action is attributable to the run that produced it.
 * The eve session id is that run identity.
 */
function runIdTool() {
  return defineAipmsTool(
    defineTool({
      description: "reads the run id of the current call",
      inputSchema: z.object({}),
      async execute() {
        return currentAgentRunId() ?? null
      },
    })
  )
}

describe("agent tool run attribution", () => {
  it("exposes the eve session id inside the tool body", async () => {
    const tool = runIdTool()
    await expect(
      tool.execute({}, { session: { id: "wrun_test" } } as never)
    ).resolves.toBe("wrun_test")
  })

  it("keeps concurrent sessions isolated", async () => {
    const tool = defineAipmsTool(
      defineTool({
        description: "reads the run id after a pause",
        inputSchema: z.object({}),
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return currentAgentRunId() ?? null
        },
      })
    )
    const [first, second] = await Promise.all([
      tool.execute({}, { session: { id: "wrun_a" } } as never),
      tool.execute({}, { session: { id: "wrun_b" } } as never),
    ])
    expect(first).toBe("wrun_a")
    expect(second).toBe("wrun_b")
  })

  it("reports no run outside a tool call", () => {
    expect(currentAgentRunId()).toBeUndefined()
  })
})
