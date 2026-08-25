import { Injectable } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import type { SessionUser } from '@workspace/auth'
import { db } from '@workspace/db'
import type {
  MiddlewareOptions,
  MiddlewareResponse,
  TRPCMiddleware,
} from 'nestjs-trpc'
import type { AuthedTrpcContext } from '../context.types'

/**
 * §7.4 agent guardrails — rate & concurrency limits for machine principals,
 * enforced in tRPC middleware ahead of every procedure:
 *
 *  - **Mutation rate**: persistent per-minute counter in the shared
 *    RateLimit store (survives restarts, works across the drain loop and
 *    interactive calls). Default 60/min, configurable via
 *    AIPMS_AGENT_RATE_LIMIT and per-principal via User.quotas.
 *  - **Concurrency**: in-process in-flight mutation cap. Single-node by
 *    deployment contract (§16.2); revisit with the queue swap in Phase 6+.
 *
 * Humans and queries are untouched — this only gates agent-driven writes.
 */

const DEFAULT_MUTATIONS_PER_MINUTE = 60
const DEFAULT_MAX_INFLIGHT = 4

interface AgentQuotaSpec {
  mutationsPerMinute: number
}

function readQuota(user: unknown): AgentQuotaSpec {
  const raw = (user as SessionUser & { quotas?: unknown }).quotas
  const parsed =
    raw && typeof raw === 'object'
      ? (raw as { mutationsPerMinute?: unknown }).mutationsPerMinute
      : undefined
  return {
    mutationsPerMinute:
      typeof parsed === 'number' && parsed > 0
        ? parsed
        : Number(process.env.AIPMS_AGENT_RATE_LIMIT ?? '') ||
          DEFAULT_MUTATIONS_PER_MINUTE,
  }
}

/** One-minute bucket keys share better-auth's RateLimit table. */
async function bumpAndCheck(userId: string, limit: number): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000)
  const key = `agent-mutation-rate:${userId}:${bucket}`

  let count: number
  try {
    const row = await db.rateLimit.update({
      where: { key },
      data: { count: { increment: 1 } },
    })
    count = row.count
  } catch {
    try {
      const row = await db.rateLimit.create({
        data: {
          id: `aq-${bucket}-${userId}`,
          key,
          count: 1,
          lastRequest: BigInt(Date.now()),
        },
      })
      count = row.count
    } catch {
      // Concurrent first-hit lost the create race — retry as an update.
      const row = await db.rateLimit.update({
        where: { key },
        data: { count: { increment: 1 } },
      })
      count = row.count
    }
  }

  if (count > limit) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `Agent mutation quota exhausted: ${count}/${limit} this minute — back off and retry`,
    })
  }
}

@Injectable()
export class AgentQuotaMiddleware implements TRPCMiddleware {
  /** agentId → in-flight mutations (single-node contract). */
  private readonly inflight = new Map<string, number>()

  async use(opts: MiddlewareOptions): Promise<MiddlewareResponse> {
    const ctx = opts.ctx as AuthedTrpcContext
    if (
      ctx.actorKind !== 'agent' ||
      opts.type !== 'mutation' ||
      !ctx.session?.user
    ) {
      return opts.next({ ctx })
    }

    const userId = ctx.session.user.id
    const quota = readQuota(ctx.session.user)

    // Reserve the slot synchronously — before any await — so parallel
    // invocations can't all squeeze past the cap during the counter's
    // async round-trip.
    const current = this.inflight.get(userId) ?? 0
    const maxInflight =
      Number(process.env.AIPMS_AGENT_CONCURRENCY ?? '') || DEFAULT_MAX_INFLIGHT
    if (current >= maxInflight) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Agent concurrency cap reached (${maxInflight} in-flight mutations)`,
      })
    }
    this.inflight.set(userId, current + 1)

    try {
      await bumpAndCheck(userId, quota.mutationsPerMinute)
      return await opts.next({ ctx })
    } finally {
      const n = this.inflight.get(userId) ?? 1
      if (n <= 1) this.inflight.delete(userId)
      else this.inflight.set(userId, n - 1)
    }
  }
}
