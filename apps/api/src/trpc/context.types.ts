import type { Session, SessionUser } from '@workspace/auth'
import type { UserKind, UserRole } from '@workspace/db'
import type { Request } from 'express'

export type BaseTrpcContext = {
  req?: Request
  session: Session | null
}

export type AuthedTrpcContext = BaseTrpcContext & {
  user: SessionUser & { kind?: UserKind; role?: UserRole }
  /** 'agent' when authenticated via service token, 'human' otherwise. */
  actorKind: UserKind
}
