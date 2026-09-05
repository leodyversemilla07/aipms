import { defineTool } from "eve/tools"
import {
  describeMessage,
  quoteInput,
  requestQuote,
} from "../lib/vendor-message"

export default defineTool({
  description:
    "Request a quotation via the vendor messaging relay. Requires a verified recipient. Custom notes require human review. This sends a message; it does not create or award a structured sourcing Quote.",
  inputSchema: quoteInput,
  async execute(input, ctx) {
    return requestQuote(input, ctx.callId)
  },
  toModelOutput(result) {
    return { type: "text", value: describeMessage(result) }
  },
})
