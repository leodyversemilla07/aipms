import { Inject, Injectable } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import type {
  MiddlewareOptions,
  MiddlewareResponse,
  TRPCMiddleware,
} from 'nestjs-trpc'
import {
  AgentQuotaExceededError,
  AgentQuotaService,
} from '../../shared/agent-quota/agent-quota.service'
import type { AuthedTrpcContext } from '../context.types'

/** Adapter only: shared service owns counters, in-flight slots and nesting. */
@Injectable()
export class AgentQuotaMiddleware implements TRPCMiddleware {
  constructor(
    @Inject(AgentQuotaService) private readonly quotas: AgentQuotaService,
  ) {}

  async use(opts: MiddlewareOptions): Promise<MiddlewareResponse> {
    const ctx = opts.ctx as AuthedTrpcContext
    if (
      ctx.actorKind !== 'agent' ||
      opts.type !== 'mutation' ||
      !ctx.session?.user
    )
      return opts.next({ ctx })
    try {
      return await this.quotas.run(
        { id: ctx.session.user.id, kind: 'agent' },
        opts.path,
        () => opts.next({ ctx }),
      )
    } catch (error) {
      if (error instanceof AgentQuotaExceededError)
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: error.message,
          cause: error,
        })
      throw error
    }
  }
}
