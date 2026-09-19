import { timingSafeEqual } from 'node:crypto'
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'

/**
 * M2M guard for machine callers (the eve agent runtime, cron, integrations).
 * The caller presents `Authorization: Bearer <AIPMS_SERVICE_TOKEN>`; actions
 * taken under it are audited with actorKind 'agent' by the controller. This
 * is the seam that lets the agent drive the pipeline without a browser
 * session.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const expected = process.env.AIPMS_SERVICE_TOKEN
    if (!expected) {
      throw new UnauthorizedException('AIPMS_SERVICE_TOKEN is not configured')
    }
    const header = request.headers.authorization
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : ''
    if (!provided || provided.length !== expected.length) {
      throw new UnauthorizedException('Invalid or missing service token')
    }
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      throw new UnauthorizedException('Invalid or missing service token')
    }
    return true
  }
}
