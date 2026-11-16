import { Injectable } from '@nestjs/common'
import { db, isSqlite, Prisma } from '@workspace/db'

export type LeaseResult<T> = { acquired: false } | { acquired: true; value: T }

/**
 * Cross-replica execution guard backed by a transaction-scoped PostgreSQL
 * advisory lock. The lock is released automatically on completion, failure,
 * connection loss, or process death.
 */
@Injectable()
export class AutomationLeaseService {
  async runExclusive<T>(
    name: string,
    task: () => Promise<T>,
  ): Promise<LeaseResult<T>> {
    const configuredTimeout = Number(
      process.env.AUTOMATION_LEASE_TIMEOUT_MS ?? 900_000,
    )
    const timeout =
      Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
        ? configuredTimeout
        : 900_000
    // SQLite serialises writers for the whole transaction, so the lease is
    // always available there. The guarded work also runs without a lease
    // transaction: the SQLite adapter allows one open transaction per
    // connection, so a lease transaction would block the work it guards
    // (the admission counters it reads live on the shared connection). The
    // deployed engine keeps the advisory lock, which is the real guard.
    if (isSqlite()) {
      return { acquired: true, value: await task() }
    }
    return db.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>(
          Prisma.sql`
            SELECT pg_try_advisory_xact_lock(
              hashtext(${`aipms:${name}`})
            ) AS "acquired"
          `,
        )
        if (!lock?.acquired) return { acquired: false }
        return { acquired: true, value: await task() }
      },
      { timeout, maxWait: 5000 },
    )
  }
}
