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

/** Requires a valid short-lived agent bearer, never the bootstrap secret. */
@Injectable()
export class AgentAccessTokenGuard implements CanActivate {
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
    if (!claims.scopes.includes('invoice.ingest')) {
      throw new ForbiddenException(
        'Agent access token lacks the invoice.ingest scope',
      )
    }
    request.agentClaims = claims
    return true
  }
}
