import { Inject } from '@nestjs/common'
import { Input, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
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
  async list(@Input() input: z.infer<typeof auditListInput>) {
    return this.audit.list(input)
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
