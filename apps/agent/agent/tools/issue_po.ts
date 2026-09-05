import { defineTool } from "eve/tools"
import { describePoResult, issuePo, issuePoInput } from "../lib/issue-po"

export default defineTool({
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
