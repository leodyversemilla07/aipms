import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import {
  type AgentAccessClaims,
  verifyAgentAccessToken,
} from './agent-access-token'

export type AgentAccessRequest = Request & { agentClaims?: AgentAccessClaims }

/**
 * Requires a valid short-lived agent bearer, never the bootstrap secret.
 * No domain scope is demanded here: the endpoint behind it only closes the
 * caller's own agent run, and the command boundary checks ownership.
 */
@Injectable()
export class AgentTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AgentAccessRequest>()
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : ''
    const claims = token ? verifyAgentAccessToken(token) : null
    if (!claims) {
      throw new UnauthorizedException('Invalid or expired agent access token')
    }
    request.agentClaims = claims
    return true
  }
}

/** Requires a valid short-lived agent bearer with the ingest scope. */
@Injectable()
export class AgentAccessTokenGuard extends AgentTokenGuard {
  canActivate(context: ExecutionContext): boolean {
    const allowed = super.canActivate(context)
    const claims = context
      .switchToHttp()
      .getRequest<AgentAccessRequest>().agentClaims
    if (!claims?.scopes.includes('invoice.ingest')) {
      throw new ForbiddenException(
        'Agent access token lacks the invoice.ingest scope',
      )
    }
    return allowed
  }
}
