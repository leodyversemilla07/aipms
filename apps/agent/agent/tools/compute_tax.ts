import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcQuery } from "../lib/trpc-client"

export default defineTool({
  description: "Computes deterministic tax for invoice lines.",
  inputSchema: z.object({
    lines: z.array(
      z.object({
        description: z.string().optional(),
        amountMinor: z.number(),
        class: z.string(),
        vatExempt: z.boolean().optional(),
      })
    ),
  }),
  async execute(input) {
    return await trpcQuery("invoice", "compute", { lines: input.lines })
  },

  toModelOutput(result: RelayPayload) {
    if (!result) return { type: "text", value: "Could not compute tax." }
    return {
      type: "text",
      value: `Gross: ${result.grossAmount}\nVAT: ${result.vatAmount}\nEWT: ${result.ewtAmount}\nNet Payable: ${result.netPayableAmount}`,
    }
  },
})
