import { isSqlite, type Prisma } from '@workspace/db'

/**
 * Serialises a critical section across writers.
 *
 * PostgreSQL takes a transaction-scoped advisory lock so two workers cannot
 * interleave the same scope (document numbers, policy versions, the audit
 * chain). SQLite serialises writers for the whole transaction, so the lock is
 * a no-op there - the same guarantee, from the engine instead of the lock.
 */
export async function lockScope(
  tx: Prisma.TransactionClient,
  name: string,
): Promise<void> {
  if (isSqlite()) return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`
}
