import { defineTool } from "eve/tools"
import {
  describeMessage,
  messageInput,
  submitVendorMessage,
} from "../lib/vendor-message"

export default defineTool({
  description:
    "Submit a vendor message through the relay. The backend verifies recipients and decides approval requirements. Report returned status; queued or approved does not mean sent.",
  inputSchema: messageInput,
  async execute(input, ctx) {
    return submitVendorMessage(input, ctx.callId)
  },
  toModelOutput(result) {
    return { type: "text", value: describeMessage(result) }
  },
})
