import { Controller, ForbiddenException, Get, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { QboService } from './qbo.service'

/**
 * Browser-facing Intuit OAuth redirect target (§8.5). Unauthenticated by
 * design — Intuit redirects here with an authorization `code`; CSRF is
 * handled by the HMAC-signed `state` parameter minted when finance started
 * the flow. On success the browser lands back on the finance desk.
 */
@Controller('api/erp/qbo')
export class QboCallbackController {
  constructor(private readonly qbo: QboService) {}

  private get appUrl(): string {
    return process.env.APP_URL ?? 'http://localhost:3000'
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('realmId') realmId: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    try {
      if (!code || !realmId || !state) {
        throw new ForbiddenException(
          'Missing code/realmId/state in OAuth callback',
        )
      }
      await this.qbo.handleCallback(code, realmId, state)
      res.redirect(302, `${this.appUrl}/finance?erp=qbo-connected`)
    } catch (err) {
      const reason = encodeURIComponent((err as Error).message.slice(0, 120))
      res.redirect(302, `${this.appUrl}/finance?erp=qbo-error&reason=${reason}`)
    }
  }
}
