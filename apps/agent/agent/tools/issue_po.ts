import { defineTool } from "eve/tools"
import { defineAipmsTool } from "../lib/agent-tool"
import { describePoResult, issuePo, issuePoInput } from "../lib/issue-po"

export default defineAipmsTool(
  defineTool({
    description:
      "Issues a PO from an approved requisition, or reports a human approval gate.",
    inputSchema: issuePoInput,
    async execute(input, ctx) {
      return issuePo(input, ctx.callId)
    },
    toModelOutput(result) {
      return { type: "text", value: describePoResult(result) }
    },
  })
)
