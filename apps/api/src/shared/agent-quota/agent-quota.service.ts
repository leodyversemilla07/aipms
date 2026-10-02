import { AsyncLocalStorage } from 'node:async_hooks'
import {
  HttpException,
  HttpStatus,
  Injectable,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common'
import { db } from '@workspace/db'

export class AgentQuotaExceededError extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS)
  }
}

export interface QuotaActor {
  id: string
  kind: 'agent' | 'human'
}
type QuotaClient = Pick<typeof db, 'user' | 'rateLimit'>
interface Frame {
  id: string
  operation: string
  active: boolean
  permit: { active: boolean }
}

function positiveInteger(value: unknown, name: string, fallback?: number) {
  if ((value === undefined || value === '') && fallback !== undefined)
    return fallback
  const number = typeof value === 'string' ? Number(value.trim()) : value
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 2_147_483_647
  ) {
    throw new ServiceUnavailableException(
      `${name} must be a positive database-range integer`,
    )
  }
  return number
}

@Injectable()
export class AgentQuotaService implements OnModuleInit {
  private readonly inflight = new Map<string, number>()
  private readonly context = new AsyncLocalStorage<Frame>()

  onModuleInit() {
    this.defaults()
  }

  private defaults() {
    return {
      rate: positiveInteger(
        process.env.AIPMS_AGENT_RATE_LIMIT,
        'AIPMS_AGENT_RATE_LIMIT',
        60,
      ),
      concurrency: positiveInteger(
        process.env.AIPMS_AGENT_CONCURRENCY,
        'AIPMS_AGENT_CONCURRENCY',
        4,
      ),
    }
  }

  /**
   * Call only after authorization. Same-operation nested adapters reuse their
   * admission; distinct child commands consume rate, but share the root slot.
   * Context is internal, not an actor/source flag a caller can forge.
   */
  async run<T>(
    actor: QuotaActor,
    operation: string,
    task: () => Promise<T>,
    client: QuotaClient = db,
  ): Promise<T> {
    if (actor.kind !== 'agent') return task()
    const limits = this.defaults()
    const parent = this.context.getStore()
    const reuse =
      parent?.active && parent.permit.active && parent.id === actor.id
    if (reuse && parent.operation === operation) return task()

    const ownsSlot = !reuse
    const permit = reuse ? parent.permit : { active: true }
    if (ownsSlot) {
      const current = this.inflight.get(actor.id) ?? 0
      if (current >= limits.concurrency)
        throw new AgentQuotaExceededError(
          `Agent concurrency cap reached (${limits.concurrency} in-flight mutations)`,
        )
      // Synchronous reservation precedes all database awaits.
      this.inflight.set(actor.id, current + 1)
    }
    let frame: Frame | undefined
    try {
      // Bearer/automation principals use current server-owned User quotas.
      // Never accept a quota override from token/body/CommandActor data.
      const user = await client.user.findUnique({
        where: { id: actor.id },
        select: { kind: true, quotas: true },
      })
      if (user && user.kind !== 'agent')
        throw new ServiceUnavailableException(
          'Machine principal conflicts with a non-agent User row',
        )
      const raw = user?.quotas
      if (
        raw !== null &&
        raw !== undefined &&
        (typeof raw !== 'object' || Array.isArray(raw))
      )
        throw new ServiceUnavailableException('Agent quotas must be an object')
      const override = (
        raw as { mutationsPerMinute?: unknown } | null | undefined
      )?.mutationsPerMinute
      if (override !== undefined && typeof override !== 'number') {
        throw new ServiceUnavailableException(
          'User.quotas.mutationsPerMinute must be a number',
        )
      }
      const rate =
        override === undefined
          ? limits.rate
          : positiveInteger(override, 'User.quotas.mutationsPerMinute')
      const now = Date.now()
      const bucket = Math.floor(now / 60_000)
      const key = `agent-mutation-rate:${actor.id}:${bucket}`
      // Native atomic upsert replaces broad catch/retry logic. Outages fail
      // closed; admission is committed independently of business rollback.
      const counter = await client.rateLimit.upsert({
        where: { key },
        create: {
          id: `aq-${bucket}-${actor.id}`,
          key,
          count: 1,
          lastRequest: BigInt(now),
        },
        update: { count: { increment: 1 }, lastRequest: BigInt(now) },
      })
      if (counter.count > rate)
        throw new AgentQuotaExceededError(
          `Agent mutation quota exhausted: ${counter.count}/${rate} this minute — back off and retry`,
        )
      frame = { id: actor.id, operation, permit, active: true }
      return await this.context.run(frame, task)
    } finally {
      // Detached callbacks cannot retain free admission after the frame ends.
      if (frame) frame.active = false
      if (ownsSlot) {
        permit.active = false
        const current = this.inflight.get(actor.id) ?? 1
        if (current <= 1) this.inflight.delete(actor.id)
        else this.inflight.set(actor.id, current - 1)
      }
    }
  }
}
