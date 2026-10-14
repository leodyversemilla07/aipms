import { Inject } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import { RetentionService } from '../shared/retention/retention.service'
import { requireHumanRole } from '../trpc/authorize'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { AnalyticsService } from './analytics.service'

/**
 * §14 observability surface — read-only aggregations for the supervisory
 * desk. Human session reads; agents have no capability entry (default deny)
 * since analytics carry cross-cutting visibility.
 */
@Router({ alias: 'analytics' })
@UseMiddlewares(AuthMiddleware)
export class AnalyticsRouter {
  constructor(
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(RetentionService)
    private readonly retentionService: RetentionService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({
    input: z.object({ months: z.number().int().min(1).max(12).default(3) }),
  })
  async overview(@Input() input: { months: number }) {
    return this.analytics.overview(input.months)
  }

  @Query({ input: z.object({ runId: z.string().min(1) }) })
  async runTrace(@Input() input: { runId: string }) {
    return this.analytics.runTrace(input.runId)
  }

  /** Storage retention metrics: idempotency keys and rate limit bucket accumulation. */
  @Query()
  async retention() {
    return this.retentionService.getSummary()
  }

  /**
   * On-demand pruning of expired idempotency keys and rate limit buckets.
   * Gated to human admin role and records an immutable audit trail entry.
   */
  @Mutation()
  async pruneRetention(@Ctx() ctx: AuthedTrpcContext) {
    requireHumanRole(
      ctx.user,
      ctx.actorKind,
      ['admin'],
      'analytics.pruneRetention',
    )
    const result = await this.retentionService.prune()
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'retention.prune',
      entity: 'Maintenance',
      after: result as unknown as object,
    })
    return result
  }
}
