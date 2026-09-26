import { ConflictException, Inject, NotFoundException } from '@nestjs/common'
import { db } from '@workspace/db'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import type { AuthedTrpcContext } from '../../trpc/context.types'
import { listInput, paginate } from '../../trpc/list-input'
import { AuthMiddleware } from '../../trpc/middlewares/auth.middleware'
import { AuditService } from '../audit/audit.service'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { getRecoverySummary } from '../operations/recovery-summary'

const pollInput = z.object({
  types: z.array(z.string()).min(1),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
})

const requeueInput = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
})

/**
 * §7.3 event subscription and §13 recovery surface. Agents can poll published
 * events, while finance operators can inspect and explicitly requeue poisoned
 * outbox deliveries through the centrally authorized human policy.
 */
@Router({ alias: 'events' })
@UseMiddlewares(AuthMiddleware)
export class EventSubscriptionRouter {
  constructor(
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: pollInput })
  async poll(
    @Input() input: z.infer<typeof pollInput>,
    @Ctx() _ctx: AuthedTrpcContext,
  ) {
    return db.domainEvent.findMany({
      where: {
        type: { in: input.types },
        publishedAt: { not: null },
        ...(input.since ? { createdAt: { gt: new Date(input.since) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: input.limit,
    })
  }

  @Query({ input: z.object({}) })
  async recoverySummary() {
    return getRecoverySummary()
  }

  @Query({ input: listInput })
  async deadLetters(@Input() input: z.infer<typeof listInput>) {
    const { skip, take } = paginate(input)
    const q = input.q.trim()
    const where = {
      deadLetteredAt: { not: null },
      ...(q
        ? {
            OR: [
              { id: { contains: q, mode: 'insensitive' as const } },
              { type: { contains: q, mode: 'insensitive' as const } },
              { entityType: { contains: q, mode: 'insensitive' as const } },
              { entityId: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      db.domainEvent.findMany({
        where,
        skip,
        take,
        orderBy: { deadLetteredAt: 'desc' },
        select: {
          id: true,
          type: true,
          entityType: true,
          entityId: true,
          attemptCount: true,
          lastError: true,
          deadLetteredAt: true,
          deadLetterReason: true,
          createdAt: true,
        },
      }),
      db.domainEvent.count({ where }),
    ])
    return { rows, total, facetCounts: {} }
  }

  @Mutation({ input: requeueInput })
  async requeue(
    @Input() input: z.infer<typeof requeueInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'events.requeue',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "domainEvent" WHERE id = ${input.id} FOR UPDATE
        `
        const event = await tx.domainEvent.findUnique({
          where: { id: input.id },
        })
        if (!event) {
          throw new NotFoundException(`Domain event ${input.id} not found`)
        }
        if (event.publishedAt) {
          throw new ConflictException('Published events cannot be requeued')
        }
        if (!event.deadLetteredAt) {
          throw new ConflictException('Event is not dead-lettered')
        }
        const changed = await tx.domainEvent.updateMany({
          where: {
            id: input.id,
            publishedAt: null,
            deadLetteredAt: { not: null },
          },
          data: {
            attemptCount: 0,
            lastError: null,
            deadLetteredAt: null,
            deadLetterReason: null,
            dispatchClaimId: null,
            dispatchClaimedAt: null,
          },
        })
        if (changed.count !== 1) {
          throw new ConflictException('Event changed; reload before requeueing')
        }
        const updated = await tx.domainEvent.findUniqueOrThrow({
          where: { id: input.id },
          select: {
            id: true,
            type: true,
            entityType: true,
            entityId: true,
            attemptCount: true,
            createdAt: true,
          },
        })
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'events.requeue',
            entity: 'DomainEvent',
            entityId: event.id,
            input: { reason: input.reason },
            before: {
              attemptCount: event.attemptCount,
              lastError: event.lastError,
              deadLetteredAt: event.deadLetteredAt,
              deadLetterReason: event.deadLetterReason,
            },
            after: { ...updated, recoveryReason: input.reason },
          },
          tx,
        )
        return updated
      },
    )
  }
}
