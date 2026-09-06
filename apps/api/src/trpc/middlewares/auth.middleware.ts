import { Inject, Injectable } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import type { SessionUser } from '@workspace/auth'
import { db, type UserKind, type UserRole } from '@workspace/db'
import type {
  MiddlewareOptions,
  MiddlewareResponse,
  TRPCMiddleware,
} from 'nestjs-trpc'
import { assertAgentCapability } from '../agent-capabilities'
import type { AuthedTrpcContext, BaseTrpcContext } from '../context.types'
import { AgentQuotaMiddleware } from './agent-quota.middleware'

@Injectable()
export class AuthMiddleware implements TRPCMiddleware {
  constructor(
    @Inject(AgentQuotaMiddleware) private readonly quota: AgentQuotaMiddleware,
  ) {}

  async use(opts: MiddlewareOptions): Promise<MiddlewareResponse> {
    const ctx = opts.ctx as BaseTrpcContext
    const user = ctx.session?.user

    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    const kind: UserKind =
      (user as SessionUser & { kind?: UserKind }).kind ?? 'human'
    // §10: load the human's role for authorization gates (least privilege if
    // the DB row is missing). Agent principals carry no role — their surface
    // is governed by scopes (§7.2), enforced below.
    let role: UserRole | undefined
    let scopes: string[] = []
    if (kind === 'human') {
      role =
        (
          await db.user.findUnique({
            where: { id: user.id },
            select: { role: true },
          })
        )?.role ?? 'user'
    } else {
      const raw = (user as SessionUser & { scopes?: unknown }).scopes
      if (Array.isArray(raw))
        scopes = raw.filter((s): s is string => typeof s === 'string')
      // §7.2 default-deny: the capability map decides what agents may call.
      assertAgentCapability(opts.path, scopes)
    }

    const nextCtx: AuthedTrpcContext = {
      ...ctx,
      user: { ...user, kind, role },
      actorKind: kind,
    }
    // Global middleware runs before router authentication in nestjs-trpc.
    // Enforce quotas here, after identity and capability checks, so every
    // protected procedure sees the authenticated actor exactly once.
    return this.quota.use({ ...opts, ctx: nextCtx })
  }
}
