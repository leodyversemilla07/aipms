import { ConflictException, Inject } from '@nestjs/common'
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
import { requireRole } from '../trpc/authorize'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { MessagingService } from './messaging.service'

const submitInput = z.object({
  idempotencyKey: z.string().min(1),
  vendorId: z.string().min(1),
  recipient: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  /** Transactional template id; omit/unknown ⇒ gated tier (§8.3). */
  templateId: z.string().min(1).max(60).optional(),
  threadId: z.string().min(1).optional(),
  /** §7.1 agent execution tag when submitted by an agent. */
  runId: z.string().min(1).optional(),
})

const decideInput = z.object({
  id: z.string().min(1),
  reason: z.string().min(1).max(500).optional(),
})

const listInputWithFilters = listInput.extend({
  status: z
    .enum(['queued', 'approved', 'rejected', 'sent', 'failed'])
    .optional(),
  tier: z.enum(['auto', 'gated']).optional(),
})

const idInput = z.object({ id: z.string().min(1) })

/**
 * §8.3 relay surface. `submit` is open to scoped agents (`messaging.submit`);
 * `approve`/`reject` are human-only — absent from the agent capability map
 * (default deny) AND role-gated here, so neither layer alone is trusted.
 */
@Router({ alias: 'messaging' })
@UseMiddlewares(AuthMiddleware)
export class MessagingRouter {
  constructor(
    @Inject(MessagingService) private readonly messaging: MessagingService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInputWithFilters })
  async list(@Input() input: z.infer<typeof listInputWithFilters>) {
    return this.messaging.list(input)
  }

  @Query({ input: idInput })
  async detail(@Input() input: z.infer<typeof idInput>) {
    return this.messaging.detail(input.id)
  }

  @Mutation({ input: submitInput })
  async submit(
    @Input() input: z.infer<typeof submitInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const { message } = await this.messaging.submit({
        vendorId: input.vendorId,
        recipient: input.recipient,
        subject: input.subject,
        body: input.body,
        templateId: input.templateId ?? null,
        threadId: input.threadId ?? null,
        agentId: ctx.actorKind === 'agent' ? ctx.user.id : null,
        runId: input.runId ?? null,
      })
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'messaging.submit',
        entity: 'Message',
        entityId: (message as { id: string }).id,
        input: {
          vendorId: input.vendorId,
          recipient: input.recipient,
          subject: input.subject,
          templateId: input.templateId ?? null,
        },
      })
      return { message }
    })
  }

  @Mutation({ input: decideInput })
  async approve(
    @Input() input: z.infer<typeof decideInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(
      ctx.user,
      ctx.actorKind,
      ['procurement', 'finance'],
      'messaging.approve',
    )
    const message = await this.messaging.approve({
      id: input.id,
      approverId: ctx.user.id,
    })
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'messaging.approve',
      entity: 'Message',
      entityId: input.id,
      after: message as object,
    })
    return { message }
  }

  @Mutation({ input: decideInput })
  async reject(
    @Input() input: z.infer<typeof decideInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(
      ctx.user,
      ctx.actorKind,
      ['procurement', 'finance'],
      'messaging.reject',
    )
    if (!input.reason) {
      throw new ConflictException('A rejection reason is required')
    }
    const message = await this.messaging.reject({
      id: input.id,
      approverId: ctx.user.id,
      reason: input.reason,
    })
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'messaging.reject',
      entity: 'Message',
      entityId: input.id,
      input: { reason: input.reason },
      after: message as object,
    })
    return { message }
  }
}
