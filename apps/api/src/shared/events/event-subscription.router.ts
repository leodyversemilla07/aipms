import { Ctx, Input, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
import { db } from '@workspace/db'
import type { AuthedTrpcContext } from '../../trpc/context.types'
import { AuthMiddleware } from '../../trpc/middlewares/auth.middleware'

const pollInput = z.object({
  types: z.array(z.string()).min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
})

/**
 * §7.3 — event subscription surface for agents. Agents poll for domain
 * events matching their interest set (e.g. "requisition.approved") to
 * decide which skill to activate next.
 */
@Router({ alias: 'events' })
@UseMiddlewares(AuthMiddleware)
export class EventSubscriptionRouter {
  @Query({ input: pollInput })
  async poll(
    @Input() input: z.infer<typeof pollInput>,
    @Ctx() _ctx: AuthedTrpcContext,
  ) {
    return db.domainEvent.findMany({
      where: {
        type: { in: input.types },
        publishedAt: { not: null },
        ...(input.since
          ? { createdAt: { gt: new Date(input.since) } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: input.limit,
    })
  }
}
