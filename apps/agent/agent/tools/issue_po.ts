import crypto from "node:crypto"
import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcMutate } from "../lib/trpc-client"

export default defineTool({
  description: "Issues a PO from an approved requisition.",
  inputSchema: z.object({
    requisitionId: z.string(),
    vendorId: z.string(),
    idempotencyKey: z.string().optional(),
    terms: z.record(z.string(), z.any()).optional(),
  }),
  async execute(input) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
    return await trpcMutate("purchaseOrder", "issue", {
      idempotencyKey,
      requisitionId: input.requisitionId,
      vendorId: input.vendorId,
      terms: input.terms,
    })
  },

  toModelOutput(result: RelayPayload) {
    return {
      type: "text",
      value: `PO Issued: ${result?.poNumber || result?.id} (Status: ${result?.status})\nTotal: ${result?.totalAmount}\nVendor: ${result?.vendorId}`,
    }
  },
})
