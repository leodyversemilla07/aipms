import { z } from "zod"
import { trpcMutate } from "./trpc-client"

export const issuePoInput = z.object({
  requisitionId: z.string().min(1),
  vendorId: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  terms: z.record(z.string(), z.unknown()).optional(),
})

const resultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ISSUED"),
    purchaseOrder: z.object({
      id: z.string(),
      poNumber: z.string(),
      status: z.string(),
      totalMinor: z.number().int(),
      currencyCode: z.string(),
      vendorId: z.string(),
    }),
  }),
  z.object({
    outcome: z.literal("NEED_APPROVAL"),
    vendorId: z.string(),
    requisitionId: z.string(),
  }),
])

export async function issuePo(
  input: z.infer<typeof issuePoInput>,
  callId: string
) {
  if (!input.idempotencyKey && !callId) {
    throw new Error("PO issuance requires an idempotency key or eve call ID")
  }
  const result = await trpcMutate("purchaseOrder", "issue", {
    ...input,
    // Interrupted eve executions replay the same call, so reuse its identity.
    idempotencyKey: input.idempotencyKey ?? `eve:purchaseOrder.issue:${callId}`,
  })
  return resultSchema.parse(result)
}

export function describePoResult(result: z.infer<typeof resultSchema>) {
  if (result.outcome === "NEED_APPROVAL") {
    return `NEED_APPROVAL: vendor ${result.vendorId} requires human review for requisition ${result.requisitionId}. No PO was issued.`
  }
  const po = result.purchaseOrder
  return `PO Issued: ${po.poNumber} (Status: ${po.status})\nTotal: ${po.totalMinor} minor units ${po.currencyCode}\nVendor: ${po.vendorId}`
}
