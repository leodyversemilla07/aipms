import './no-database'
import { ServiceUnavailableException } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalyticsRouter } from '../../src/analytics/analytics.router'
import type { AnalyticsService } from '../../src/analytics/analytics.service'
import type { AuditService } from '../../src/shared/audit/audit.service'
import type { AutomationLeaseService } from '../../src/shared/automation/automation-lease.service'
import { RetentionService } from '../../src/shared/retention/retention.service'
import type { RetentionDbClient } from '../../src/shared/retention/retention-policy'
import type { AuthedTrpcContext } from '../../src/trpc/context.types'

describe('Data retention & pruning (§13 / §16)', () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...originalEnv }
    vi.useRealTimers()
  })

  function mockLeases(acquired = true) {
    return {
      runExclusive: vi.fn(async (_name: string, fn: () => Promise<unknown>) => {
        if (!acquired) return { acquired: false as const }
        return { acquired: true as const, value: await fn() }
      }),
    } as unknown as AutomationLeaseService
  }

  function mockDb(records: {
    idempotencyKeys?: Array<{ id: string; createdAt: Date }>
    rateLimits?: Array<{ id: string; lastRequest: bigint }>
  }): RetentionDbClient {
    let keys = [...(records.idempotencyKeys ?? [])]
    let rates = [...(records.rateLimits ?? [])]

    return {
      idempotencyKey: {
        deleteMany: vi.fn(async ({ where }) => {
          const initial = keys.length
          keys = keys.filter((k) => k.createdAt >= where.createdAt.lt)
          return { count: initial - keys.length }
        }),
        count: vi.fn(async (args) => {
          if (!args?.where?.createdAt?.lt) return keys.length
          const cutoff = args.where.createdAt.lt
          return keys.filter((k) => k.createdAt < cutoff).length
        }),
      },
      rateLimit: {
        deleteMany: vi.fn(async ({ where }) => {
          const initial = rates.length
          rates = rates.filter((r) => r.lastRequest >= where.lastRequest.lt)
          return { count: initial - rates.length }
        }),
        count: vi.fn(async (args) => {
          if (!args?.where?.lastRequest?.lt) return rates.length
          const cutoff = args.where.lastRequest.lt
          return rates.filter((r) => r.lastRequest < cutoff).length
        }),
      },
    }
  }

  describe('Configuration & Parsing', () => {
    it('applies standard defaults in test environment', () => {
      delete process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS
      delete process.env.AIPMS_RATE_LIMIT_RETENTION_DAYS
      delete process.env.AIPMS_RETENTION_INTERVAL_MS
      delete process.env.AIPMS_RETENTION_ENABLED

      const service = new RetentionService(mockLeases())
      const config = service.config()

      expect(config.idempotencyRetentionDays).toBe(30)
      expect(config.rateLimitRetentionDays).toBe(7)
      expect(config.intervalMs).toBe(86_400_000)
      expect(config.enabled).toBe(false) // in test env defaults to false
    })

    it('honors valid environment overrides', () => {
      process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS = '60'
      process.env.AIPMS_RATE_LIMIT_RETENTION_DAYS = '14'
      process.env.AIPMS_RETENTION_INTERVAL_MS = '3600000'
      process.env.AIPMS_RETENTION_ENABLED = '1'

      const service = new RetentionService(mockLeases())
      const config = service.config()

      expect(config.idempotencyRetentionDays).toBe(60)
      expect(config.rateLimitRetentionDays).toBe(14)
      expect(config.intervalMs).toBe(3_600_000)
      expect(config.enabled).toBe(true)
    })

    it('rejects invalid or non-integer configuration', () => {
      process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS = 'invalid'
      const service = new RetentionService(mockLeases())
      expect(() => service.config()).toThrow(ServiceUnavailableException)

      process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS = '-5'
      expect(() => service.config()).toThrow(ServiceUnavailableException)

      process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS = '30'
      process.env.AIPMS_RETENTION_ENABLED = 'yes'
      expect(() => service.config()).toThrow(ServiceUnavailableException)
    })
  })

  describe('RetentionService.prune', () => {
    it('deletes rows older than cutoffs and preserves recent rows', async () => {
      const now = new Date('2026-10-14T12:00:00.000Z')
      vi.useFakeTimers({ now })

      process.env.AIPMS_IDEMPOTENCY_RETENTION_DAYS = '30'
      process.env.AIPMS_RATE_LIMIT_RETENTION_DAYS = '7'

      const dayMs = 86_400_000
      const client = mockDb({
        idempotencyKeys: [
          { id: 'k-old-1', createdAt: new Date(now.getTime() - 40 * dayMs) }, // expired
          { id: 'k-old-2', createdAt: new Date(now.getTime() - 31 * dayMs) }, // expired
          { id: 'k-fresh-1', createdAt: new Date(now.getTime() - 10 * dayMs) }, // kept
          { id: 'k-fresh-2', createdAt: now }, // kept
        ],
        rateLimits: [
          { id: 'r-old-1', lastRequest: BigInt(now.getTime() - 10 * dayMs) }, // expired
          { id: 'r-fresh-1', lastRequest: BigInt(now.getTime() - 2 * dayMs) }, // kept
          { id: 'r-fresh-2', lastRequest: BigInt(now.getTime()) }, // kept
        ],
      })

      const service = new RetentionService(mockLeases())
      const result = await service.prune(client)

      expect(result.prunedIdempotencyKeys).toBe(2)
      expect(result.prunedRateLimits).toBe(1)
      expect(result.idempotencyCutoff).toEqual(
        new Date(now.getTime() - 30 * dayMs),
      )
      expect(result.rateLimitCutoff).toEqual(
        new Date(now.getTime() - 7 * dayMs),
      )

      const remainingKeys = await client.idempotencyKey.count()
      const remainingRates = await client.rateLimit.count()
      expect(remainingKeys).toBe(2)
      expect(remainingRates).toBe(2)
    })
  })

  describe('RetentionService.getSummary', () => {
    it('accurately reports storage counts and expired counts without mutating', async () => {
      const now = new Date('2026-10-14T12:00:00.000Z')
      vi.useFakeTimers({ now })

      const dayMs = 86_400_000
      const client = mockDb({
        idempotencyKeys: [
          { id: 'k-old', createdAt: new Date(now.getTime() - 35 * dayMs) },
          { id: 'k-new', createdAt: now },
        ],
        rateLimits: [
          { id: 'r-old', lastRequest: BigInt(now.getTime() - 8 * dayMs) },
          { id: 'r-new', lastRequest: BigInt(now.getTime()) },
        ],
      })

      const service = new RetentionService(mockLeases())
      const summary = await service.getSummary(client)

      expect(summary.idempotency).toEqual({
        total: 2,
        expired: 1,
        retentionDays: 30,
        cutoff: new Date(now.getTime() - 30 * dayMs),
      })
      expect(summary.rateLimit).toEqual({
        total: 2,
        expired: 1,
        retentionDays: 7,
        cutoff: new Date(now.getTime() - 7 * dayMs),
      })
    })
  })

  describe('RetentionService.tick', () => {
    it('executes prune inside an automation lease', async () => {
      const leases = mockLeases(true)
      const service = new RetentionService(leases)
      const client = mockDb({})

      const result = await service.tick(client)
      expect(leases.runExclusive).toHaveBeenCalledWith(
        'data-retention-prune',
        expect.any(Function),
      )
      expect(result).not.toBeNull()
      expect(result?.prunedIdempotencyKeys).toBe(0)
    })

    it('returns null and skips execution when lease is owned by another replica', async () => {
      const leases = mockLeases(false)
      const service = new RetentionService(leases)
      const client = mockDb({})

      const result = await service.tick(client)
      expect(result).toBeNull()
    })
  })

  describe('AnalyticsRouter retention procedures', () => {
    it('exposes retention summary to procurement and finance roles', async () => {
      const summaryData = {
        idempotency: {
          total: 10,
          expired: 2,
          retentionDays: 30,
          cutoff: new Date(),
        },
        rateLimit: {
          total: 5,
          expired: 1,
          retentionDays: 7,
          cutoff: new Date(),
        },
        checkedAt: new Date(),
      }
      const retentionService = {
        getSummary: vi.fn().mockResolvedValue(summaryData),
        prune: vi.fn(),
      } as unknown as RetentionService

      const router = new AnalyticsRouter(
        {} as AnalyticsService,
        retentionService,
        {} as AuditService,
      )

      const result = await router.retention()
      expect(result).toEqual(summaryData)
    })

    it('allows admin human callers to trigger prune and writes an audit record', async () => {
      const pruneData = {
        prunedIdempotencyKeys: 5,
        prunedRateLimits: 3,
        idempotencyCutoff: new Date(),
        rateLimitCutoff: new Date(),
        durationMs: 12,
      }
      const retentionService = {
        getSummary: vi.fn(),
        prune: vi.fn().mockResolvedValue(pruneData),
      } as unknown as RetentionService

      const auditService = {
        record: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      } as unknown as AuditService

      const router = new AnalyticsRouter(
        {} as AnalyticsService,
        retentionService,
        auditService,
      )

      const ctx = {
        user: { id: 'admin-1', role: 'admin', kind: 'human' },
        actorKind: 'human',
      } as unknown as AuthedTrpcContext

      const result = await router.pruneRetention(ctx)
      expect(result).toEqual(pruneData)
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'admin-1',
          actorKind: 'human',
          action: 'retention.prune',
          entity: 'Maintenance',
        }),
      )
    })

    it('forbids non-admin and agent callers from triggering pruneRetention', async () => {
      const router = new AnalyticsRouter(
        {} as AnalyticsService,
        {} as RetentionService,
        {} as AuditService,
      )

      const nonAdminCtx = {
        user: { id: 'buyer-1', role: 'procurement', kind: 'human' },
        actorKind: 'human',
      } as unknown as AuthedTrpcContext

      await expect(router.pruneRetention(nonAdminCtx)).rejects.toThrow(
        TRPCError,
      )

      const agentCtx = {
        user: { id: 'agent-1', role: 'admin', kind: 'agent' },
        actorKind: 'agent',
      } as unknown as AuthedTrpcContext

      await expect(router.pruneRetention(agentCtx)).rejects.toThrow(TRPCError)
    })
  })
})
