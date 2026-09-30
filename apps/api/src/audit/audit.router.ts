import { Inject } from '@nestjs/common'
import { Ctx, Input, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'

const auditListInput = listInput.extend({
  entity: z.string().optional(),
  action: z.string().optional(),
})

/**
 * §16 — review of the append-only trail. Read-only by construction: the
 * AuditService exposes record/list/meta and nothing else; AuditEntry has no
 * update/delete path.
 */
@Router({ alias: 'audit' })
@UseMiddlewares(AuthMiddleware)
export class AuditRouter {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Query({ input: auditListInput })
  async list(
    @Input() input: z.infer<typeof auditListInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const result = await this.audit.list(input)
    if (ctx.actorKind !== 'agent') return result
    // Snapshots may contain raw intake or protected finance data. Machine
    // audit access is metadata-only, never a back door into those payloads.
    return {
      ...result,
      rows: result.rows.map((row) => ({ ...row, before: null, after: null })),
    }
  }

  @Query()
  async meta() {
    return this.audit.meta()
  }

  /** §16.3 — recompute the hash chain; any tampering since the first entry shows here. */
  @Query()
  async chain() {
    return this.audit.verifyChain()
  }
}
