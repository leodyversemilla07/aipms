export const DEFAULT_IDEMPOTENCY_RETENTION_DAYS = 30
export const DEFAULT_RATE_LIMIT_RETENTION_DAYS = 7
export const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface RetentionConfig {
  idempotencyRetentionDays: number
  rateLimitRetentionDays: number
  intervalMs: number
  enabled: boolean
}

export interface PruneResult {
  prunedIdempotencyKeys: number
  prunedRateLimits: number
  idempotencyCutoff: Date
  rateLimitCutoff: Date
  durationMs: number
}

export interface RetentionSummary {
  idempotency: {
    total: number
    expired: number
    retentionDays: number
    cutoff: Date
  }
  rateLimit: {
    total: number
    expired: number
    retentionDays: number
    cutoff: Date
  }
  checkedAt: Date
}

export interface RetentionDbClient {
  idempotencyKey: {
    deleteMany: (args: {
      where: { createdAt: { lt: Date } }
    }) => Promise<{ count: number }>
    count: (args?: { where?: { createdAt?: { lt: Date } } }) => Promise<number>
  }
  rateLimit: {
    deleteMany: (args: {
      where: { lastRequest: { lt: bigint } }
    }) => Promise<{ count: number }>
    count: (args?: {
      where?: { lastRequest?: { lt: bigint } }
    }) => Promise<number>
  }
}
