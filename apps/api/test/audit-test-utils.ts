import { db, type Prisma } from '@workspace/db'

/** Explicit transaction-local break-glass used only by audit integrity tests. */
export function withAuditMaintenance<T>(
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('aipms.allow_audit_mutation', 'on', true)`
    return action(tx)
  })
}
