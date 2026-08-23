import crypto from "node:crypto"
import { defineTool } from "eve/tools"
import { z } from "zod"
import type { RelayPayload } from "../lib/relay-payload"
import { trpcMutate } from "../lib/trpc-client"

/**
 * §8.1 — records goods/services received against a PO. This is the middle
 * leg of the three-way match: recording a receipt re-matches any invoices
 * parked awaiting goods on that PO. Quantities are validated server-side
 * against the ordered amounts (over-receipt is refused).
 */
export default defineTool({
  description:
    "Records a delivery of goods/services against a purchase order. Lines mirror PO line numbers; cumulative received quantity can never exceed what was ordered.",
  inputSchema: z.object({
    poId: z.string(),
    lines: z
      .array(
        z.object({
          lineNo: z.number().int().min(1).optional(),
          sku: z.string().optional(),
          description: z.string().min(1),
          quantity: z.number().int().min(1),
          unit: z.string().optional(),
        })
      )
      .min(1),
    note: z.string().max(500).optional(),
    idempotencyKey: z.string().optional(),
  }),
  async execute(input) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID()
    return await trpcMutate("receipt", "record", {
      idempotencyKey,
      poId: input.poId,
      lines: input.lines,
      note: input.note,
    })
  },

  toModelOutput(result: RelayPayload) {
    if (!result?.receipt)
      return { type: "text", value: "Receipt recording failed." }
    const r = result.receipt
    const rm = result.rematch ?? {}
    const rematch =
      rm.considered > 0
        ? `, re-matched ${rm.matched ?? 0} waiting invoice(s) (${rm.exceptions ?? 0} exceptions)`
        : ""
    return {
      type: "text",
      value: `Receipt ${r.receiptNumber} recorded against ${r.poId}${rematch}.`,
    }
  },
})
