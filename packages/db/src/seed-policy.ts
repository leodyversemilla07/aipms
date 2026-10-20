import type { Prisma } from "./generated/prisma/client"
import { isSqlite } from "./provider"

/** Caller owns the transaction. Never re-enable defaults in an existing series. */
export async function ensureDefaultThreshold(tx: Prisma.TransactionClient) {
  // PostgreSQL serialises the policy version with an advisory lock; SQLite
  // serialises writers for the whole transaction.
  if (!isSqlite()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"policy-version:threshold"}))`
  }
  const threshold = await tx.policy.findFirst({ where: { kind: "threshold" } })
  if (threshold) return threshold
  return tx.policy.create({
    data: {
      name: "Requisition threshold (default)",
      kind: "threshold",
      enabled: true,
      version: 1,
      config: { autoApproveUpTo: 50_00000, budgetRequired: false },
      updatedBy: "seed",
    },
  })
}
