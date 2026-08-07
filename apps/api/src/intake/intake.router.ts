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
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { IntakeService } from './intake.service'

const ingestInput = z.object({
  idempotencyKey: z.string().min(1),
  channel: z.string().min(1).max(40),
  contentHash: z.string().min(1).max(128),
  senderId: z.string().min(1).optional(),
  raw: z.unknown().optional(),
})

const classifyInput = z.object({
  id: z.string().min(1),
  classified: z.unknown(),
})

const listInputWithStatus = listInput.extend({
  status: z
    .enum([
      'new',
      'classifying',
      'extracted',
      'matched',
      'exception',
      'dropped',
    ])
    .optional(),
})

const idInput = z.object({ id: z.string().min(1) })

@Router({ alias: 'intake' })
@UseMiddlewares(AuthMiddleware)
export class IntakeRouter {
  constructor(
    @Inject(IntakeService) private readonly intake: IntakeService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInputWithStatus })
  async list(@Input() input: z.infer<typeof listInputWithStatus>) {
    return this.intake.list(input.status ? { status: input.status } : {})
  }

  @Mutation({ input: ingestInput })
  async ingest(
    @Input() input: z.infer<typeof ingestInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const doc = await this.intake.ingest(input)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: 'human',
        action: 'intake.ingest',
        entity: 'IntakeDocument',
        entityId: doc.id,
        input,
      })
      return doc
    })
  }

  @Mutation({ input: classifyInput })
  async classify(
    @Input() input: z.infer<typeof classifyInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.classify(input)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'intake.classify',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
      after: doc,
    })
    return doc
  }

  @Mutation({ input: idInput })
  async drop(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.drop(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'intake.drop',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
    })
    return doc
  }

  @Mutation({ input: idInput })
  async requeue(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.requeue(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: 'human',
      action: 'intake.requeue',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
    })
    return doc
  }
}
