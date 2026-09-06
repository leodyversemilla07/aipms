import { defineTool } from "eve/tools"
import {
  describeMessage,
  messageInput,
  submitVendorMessage,
} from "../lib/vendor-message"

export default defineTool({
  description:
    "Submit a free-form vendor message through the relay. The backend verifies recipients and always queues these for human approval before sending. Report returned status; queued or approved does not mean sent.",
  inputSchema: messageInput,
  async execute(input, ctx) {
    return submitVendorMessage(input, ctx.callId)
  },
  toModelOutput(result) {
    return { type: "text", value: describeMessage(result) }
  },
})
