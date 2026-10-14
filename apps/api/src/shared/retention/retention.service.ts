import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common'
import { db } from '@workspace/db'
import { AutomationLeaseService } from '../automation/automation-lease.service'
import {
  DEFAULT_IDEMPOTENCY_RETENTION_DAYS,
  DEFAULT_RATE_LIMIT_RETENTION_DAYS,
  DEFAULT_RETENTION_INTERVAL_MS,
  type PruneResult,
  type RetentionConfig,
  type RetentionDbClient,
  type RetentionSummary,
} from './retention-policy'

function positiveInteger(
  value: unknown,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback
  const parsed =
    typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 2_147_483_647
  ) {
    throw new ServiceUnavailableException(
      `${name} must be a positive database-range integer`,
    )
  }
  return parsed
}

/**
 * §13 / §16 Operational Retention & Pruning Worker:
 *
 * Periodically removes expired idempotency keys and per-minute rate-limit buckets
 * to prevent unbounded database table accumulation.
 *
 * Execution is protected by a cross-replica advisory transaction lock via
 * `AutomationLeaseService`, ensuring that only one API instance prunes at a time.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name)
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private stopping = false

  constructor(private readonly leases: AutomationLeaseService) {}

  onModuleInit() {
    const config = this.config()
    if (!config.enabled) {
      this.logger.log('retention pruning worker disabled')
      return
    }
    this.stopping = false
    this.timer = setInterval(() => void this.tick(), config.intervalMs)
    this.timer.unref?.()
    this.logger.log(
      `retention pruning worker enabled: every ${config.intervalMs}ms (idempotency: ${config.idempotencyRetentionDays}d, rateLimits: ${config.rateLimitRetentionDays}d)`,
    )
  }

  onModuleDestroy() {
    this.stopping = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  config(): RetentionConfig {
    const enabledRaw = process.env.AIPMS_RETENTION_ENABLED
    if (enabledRaw !== undefined && !['0', '1'].includes(enabledRaw)) {
      throw new ServiceUnavailableException(
        'AIPMS_RETENTION_ENABLED must be 0 or 1',
      )
    }
    const enabled =
      enabledRaw === '1' ||
      (enabledRaw === undefined && process.env.NODE_ENV !== 'test')

    return {
      enabled,
      idempotencyRetentionDays: positiveInteger(
        process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS,
        'AIPMS_IDEMPOTENCY_RETENTION_DAYS',
        DEFAULT_IDEMPOTENCY_RETENTION_DAYS,
      ),
      rateLimitRetentionDays: positiveInteger(
        process.env.AIPMS_RATE_LIMIT_RETENTION_DAYS,
        'AIPMS_RATE_LIMIT_RETENTION_DAYS',
        DEFAULT_RATE_LIMIT_RETENTION_DAYS,
      ),
      intervalMs: positiveInteger(
        process.env.AIPMS_RETENTION_INTERVAL_MS,
        'AIPMS_RETENTION_INTERVAL_MS',
        DEFAULT_RETENTION_INTERVAL_MS,
      ),
    }
  }

  /**
   * Execute pruning of expired idempotency keys and rate limit buckets.
   * Pure domain cleanup — safe to run on-demand or in worker passes.
   */
  async prune(client: RetentionDbClient = db): Promise<PruneResult> {
    const start = Date.now()
    const config = this.config()
    const idempotencyCutoff = new Date(
      Date.now() - config.idempotencyRetentionDays * 86_400_000,
    )
    const rateLimitCutoff = new Date(
      Date.now() - config.rateLimitRetentionDays * 86_400_000,
    )
    const rateLimitCutoffBigInt = BigInt(rateLimitCutoff.getTime())

    const [idempotencyResult, rateLimitResult] = await Promise.all([
      client.idempotencyKey.deleteMany({
        where: { createdAt: { lt: idempotencyCutoff } },
      }),
      client.rateLimit.deleteMany({
        where: { lastRequest: { lt: rateLimitCutoffBigInt } },
      }),
    ])

    return {
      prunedIdempotencyKeys: idempotencyResult.count,
      prunedRateLimits: rateLimitResult.count,
      idempotencyCutoff,
      rateLimitCutoff,
      durationMs: Date.now() - start,
    }
  }

  /**
   * Summary of current storage status and volume of expired rows awaiting pruning.
   */
  async getSummary(client: RetentionDbClient = db): Promise<RetentionSummary> {
    const config = this.config()
    const idempotencyCutoff = new Date(
      Date.now() - config.idempotencyRetentionDays * 86_400_000,
    )
    const rateLimitCutoff = new Date(
      Date.now() - config.rateLimitRetentionDays * 86_400_000,
    )
    const rateLimitCutoffBigInt = BigInt(rateLimitCutoff.getTime())

    const [
      totalIdempotency,
      expiredIdempotency,
      totalRateLimit,
      expiredRateLimit,
    ] = await Promise.all([
      client.idempotencyKey.count(),
      client.idempotencyKey.count({
        where: { createdAt: { lt: idempotencyCutoff } },
      }),
      client.rateLimit.count(),
      client.rateLimit.count({
        where: { lastRequest: { lt: rateLimitCutoffBigInt } },
      }),
    ])

    return {
      idempotency: {
        total: totalIdempotency,
        expired: expiredIdempotency,
        retentionDays: config.idempotencyRetentionDays,
        cutoff: idempotencyCutoff,
      },
      rateLimit: {
        total: totalRateLimit,
        expired: expiredRateLimit,
        retentionDays: config.rateLimitRetentionDays,
        cutoff: rateLimitCutoff,
      },
      checkedAt: new Date(),
    }
  }

  /**
   * Single scheduled pass protected by cross-replica lease lock.
   */
  async tick(client: RetentionDbClient = db): Promise<PruneResult | null> {
    if (this.running || this.stopping) return null
    this.running = true
    try {
      const leased = await this.leases.runExclusive(
        'data-retention-prune',
        () => this.prune(client),
      )
      if (!leased.acquired) {
        this.logger.debug(
          'retention prune skipped: another replica owns the lease',
        )
        return null
      }
      const res = leased.value
      if (res.prunedIdempotencyKeys > 0 || res.prunedRateLimits > 0) {
        this.logger.log(
          `retention prune: removed ${res.prunedIdempotencyKeys} idempotency keys and ${res.prunedRateLimits} rate limit buckets in ${res.durationMs}ms`,
        )
      }
      return res
    } catch (error) {
      this.logger.error(`retention prune failed: ${(error as Error).message}`)
      throw error
    } finally {
      this.running = false
    }
  }
}
