import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcMutate } from "../lib/trpc-client"

const resultSchema = z.object({
  requisition: z.object({
    id: z.string(),
    requestNumber: z.string(),
    status: z.string(),
  }),
  decision: z.object({
    outcome: z.string(),
    citations: z.array(z.string()).optional(),
  }),
})

export default defineTool({
  description:
    "Submits a draft requisition to the deterministic policy engine. Stop and report any NEED_APPROVAL or BLOCK result; never approve on a human's behalf.",
  inputSchema: z.object({
    id: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
  }),
  async execute(input, ctx) {
    const result = await trpcMutate("requisition", "submit", {
      ...input,
      idempotencyKey:
        input.idempotencyKey ?? `eve:requisition.submit:${ctx.callId}`,
    })
    return resultSchema.parse(result)
  },
  toModelOutput(result) {
    const citations = result.decision.citations?.length
      ? ` Citations: ${result.decision.citations.join(", ")}.`
      : ""
    return {
      type: "text",
      value: `${result.requisition.requestNumber} submission outcome: ${result.decision.outcome}; status: ${result.requisition.status}.${citations}`,
    }
  },
})
