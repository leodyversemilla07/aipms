import { ConflictException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'

/**
 * Run after locking invoices. Read PO state without taking PO locks here:
 * corrections lock PO → invoice, so taking the inverse order could deadlock.
 * Their invoice locks/claim checks serialize cancellation with new planning.
 * Recheck references even for legacy invoices whose stored match is stale.
 */
export async function assertLiveInvoicePurchaseOrders(
  invoices: readonly { number: string; poId: string | null }[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  const poIds = [
    ...new Set(
      invoices
        .map((invoice) => invoice.poId)
        .filter((id): id is string => id !== null),
    ),
  ]
  if (poIds.length === 0) return
  const orders = await tx.purchaseOrder.findMany({
    where: { id: { in: poIds } },
    select: { id: true, status: true },
  })
  const liveIds = new Set(
    orders
      .filter((po) => po.status === 'issued' || po.status === 'confirmed')
      .map((po) => po.id),
  )
  for (const invoice of invoices) {
    if (invoice.poId !== null && !liveIds.has(invoice.poId)) {
      throw new ConflictException(
        `Invoice ${invoice.number} references a missing or non-live PO — correct its eligibility before planning payments`,
      )
    }
  }
}
