import { Injectable } from '@nestjs/common'
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
 */
const INFLIGHT = { __inflight: true } as const

@Injectable()
export class IdempotencyService {
  async run<T = object>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = await db.idempotencyKey.findUnique({ where: { key } })

    if (existing) {
      // A concurrent attempt already owns this key; it may still be inflight.
      return existing.resultJson as T
    }

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
        if (theirs) return theirs.resultJson as T
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
}
