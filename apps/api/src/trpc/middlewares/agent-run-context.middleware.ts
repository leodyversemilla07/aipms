import { Injectable } from '@nestjs/common'
import type { SessionUser } from '@workspace/auth'
import type {
  MiddlewareOptions,
  MiddlewareResponse,
  TRPCMiddleware,
} from 'nestjs-trpc'
import { withAgentRunContext } from '../../shared/audit/agent-run-context'
import type { BaseTrpcContext } from '../context.types'

/**
 * §7.1 — bind the agent run id to the request.
 *
 * The run id travels in the five-minute agent bearer (the eve session id the
 * API minted the token for). It is put in scope for the whole call, so every
 * audit entry the agent's tools cause carries the run id — without each
 * router having to know about it.
 *
 * Human callers get no run id: the scope stays undefined and the audit trail
 * keeps recording human actions the way it always did.
 */
@Injectable()
export class AgentRunContextMiddleware implements TRPCMiddleware {
  async use(opts: MiddlewareOptions): Promise<MiddlewareResponse> {
    const ctx = opts.ctx as BaseTrpcContext
    const user = ctx.session?.user as
      | (SessionUser & { kind?: string; runId?: string })
      | undefined
    const runId = user?.kind === 'agent' ? user.runId : undefined

    // The handler runs inside `opts.next()`, so the scope covers it.
    return withAgentRunContext(runId, () => opts.next())
  }
}
