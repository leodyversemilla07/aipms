import { Inject } from '@nestjs/common'
import { db } from '@workspace/db'
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

/** A checkpoint retained outside the database: which entry, and its hash. */
const checkpointInput = z.object({
  seq: z.number().int().positive(),
  entryHash: z.string().min(16).max(128),
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

  /**
   * §16.3 — the current chain head. An operator retains this outside the
   * database; verification against it is what detects a removed trail tip.
   */
  @Query()
  async checkpoint() {
    return this.audit.checkpoint()
  }

  /**
   * §16.3 — recompute the hash chain; any tampering since the first entry
   * shows here. Passing a retained checkpoint also proves the trail still
   * ends where the checkpoint says it did.
   */
  @Query({ input: z.object({ expected: checkpointInput.optional() }) })
  async chain(@Input() input: { expected?: z.infer<typeof checkpointInput> }) {
    return this.audit.verifyChain(db, input.expected)
  }
}
