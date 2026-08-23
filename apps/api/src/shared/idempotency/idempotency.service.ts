import { setTimeout as sleep } from 'node:timers/promises'
import { ConflictException, Injectable } from '@nestjs/common'
import { db, Prisma } from '@workspace/db'

/**
 * §9 idempotency: mutating procedures take an idempotency key so agent retries
 * are safe. The key resolves to a stored outcome: a repeat call returns the
 * previously stored result instead of re-executing the mutation.
 *
 * Claim protocol (handles concurrent retries without relying on app-level
 * read-then-write): the first attempt claims the key with an inflight marker;
 * a concurrent duplicate hits the unique constraint, re-reads, and returns the
 * winner's outcome. If the mutation fails the claim is removed so a retry can
 * re-run; on success the real result replaces the marker.
 *
 * A caller that observes an in-flight claim does not get the marker back: it
 * waits (bounded by IDEMPOTENCY_WAIT_MS) for the winner to publish its
 * outcome, and re-claims if the winner failed and released the key.
 */
const INFLIGHT = { __inflight: true } as const

function isInflight(resultJson: unknown): boolean {
  return (
    typeof resultJson === 'object' &&
    resultJson !== null &&
    (resultJson as { __inflight?: boolean }).__inflight === true
  )
}

@Injectable()
export class IdempotencyService {
  async run<T = object>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = await db.idempotencyKey.findUnique({ where: { key } })

    if (existing) {
      if (!isInflight(existing.resultJson)) {
        return existing.resultJson as T
      }
      // A concurrent attempt owns this key and is still executing.
      return this.waitForOutcome(key, () => this.claimAndRun(key, fn))
    }
    return this.claimAndRun(key, fn)
  }

  private async claimAndRun<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let claimId: string
    try {
      const claim = await db.idempotencyKey.create({
        data: { key, resultJson: INFLIGHT },
      })
      claimId = claim.id
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const theirs = await db.idempotencyKey.findUnique({ where: { key } })
        if (theirs) {
          if (!isInflight(theirs.resultJson)) {
            return theirs.resultJson as T
          }
          return this.waitForOutcome(key, () => this.claimAndRun(key, fn))
        }
      }
      throw error
    }

    try {
      const result = await fn()
      const serializable = result as object
      await db.idempotencyKey.update({
        where: { id: claimId },
        data: { resultJson: serializable },
      })
      return result
    } catch (error) {
      // Release the claim on failure so a retry can re-run the work.
      await db.idempotencyKey.delete({ where: { id: claimId } }).catch(() => {})
      throw error
    }
  }

  /**
   * The winner of the claim is still executing: poll for its outcome. If it
   * failed and released the claim, the key vanishes — re-claim and run. Bounded
   * by IDEMPOTENCY_WAIT_MS (default 3000ms) so callers never hang.
   */
  private async waitForOutcome<T>(
    key: string,
    rerun: () => Promise<T>,
  ): Promise<T> {
    const deadline =
      Date.now() + Number(process.env.IDEMPOTENCY_WAIT_MS ?? 3000)
    while (Date.now() < deadline) {
      await sleep(50)
      const row = await db.idempotencyKey.findUnique({ where: { key } })
      if (!row) return rerun()
      if (!isInflight(row.resultJson)) return row.resultJson as T
    }
    throw new ConflictException(
      `Idempotency key ${key} is still in flight; retry shortly`,
    )
  }
}
