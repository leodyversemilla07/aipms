import { Injectable } from '@nestjs/common'
import { db, Prisma } from '@workspace/db'

export type LeaseResult<T> =
  | { acquired: false }
  | { acquired: true; value: T }

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
