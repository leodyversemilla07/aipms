import { createHash, timingSafeEqual } from 'node:crypto'
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

/** Dedicated read-only credential boundary for external health monitoring. */
@Injectable()
export class OperationsMonitoringGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.OPERATIONS_MONITORING_TOKEN?.trim()
    if (!expected) {
      throw new ServiceUnavailableException(
        'Operational monitoring is not configured',
      )
    }
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string | string[] }
    }>()
    const header = request.headers.authorization
    const authorization = Array.isArray(header) ? header[0] : header
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : ''
    if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
      throw new UnauthorizedException('Invalid monitoring credential')
    }
    return true
  }
}
