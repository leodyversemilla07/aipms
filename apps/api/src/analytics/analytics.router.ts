import { Inject } from '@nestjs/common'
import { Input, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
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
}
