import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { auth } from '@workspace/auth'
import { db } from '@workspace/db'
import { fromNodeHeaders } from 'better-auth/node'
import type { Request, Response } from 'express'
import { QboService } from './qbo.service'

/**
 * Browser-facing Intuit OAuth redirect target (§8.5). The callback is
 * proxied through the web origin to preserve Better Auth's session cookie;
 * the state can only be consumed once by the session that started the flow.
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
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      if (!code || !realmId || !state) {
        throw new ForbiddenException(
          'Missing code/realmId/state in OAuth callback',
        )
      }
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      })
      const user = session
        ? await db.user.findUnique({
            where: { id: session.user.id },
            select: { kind: true, role: true },
          })
        : null
      if (
        !session ||
        user?.kind !== 'human' ||
        (user.role !== 'admin' && user.role !== 'finance')
      ) {
        throw new ForbiddenException(
          'Finance session required for OAuth callback',
        )
      }
      await this.qbo.handleCallback(code, realmId, state, {
        userId: session.user.id,
        sessionId: session.session.id,
      })
      res.redirect(302, `${this.appUrl}/finance?erp=qbo-connected`)
    } catch {
      // Do not echo provider errors or authorization codes into a URL/log.
      res.redirect(302, `${this.appUrl}/finance?erp=qbo-error`)
    }
  }
}
