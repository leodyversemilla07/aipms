import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { AuditService } from '../shared/audit/audit.service'
import { resolveAgentScopes } from '../trpc/agent-capabilities'
import { issueAgentAccessToken } from './agent-access-token'
import {
  type AgentAccessRequest,
  AgentAccessTokenGuard,
} from './agent-access-token.guard'
import { AgentCommandService } from './agent-command.service'
import { ServiceTokenGuard } from './service-token.guard'

function configuredAgentId() {
  const id = process.env.AIPMS_AGENT_ID?.trim() || 'agent-operator'
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) {
    throw new Error('AIPMS_AGENT_ID contains invalid characters')
  }
  return id
}

/**
 * Machine-facing REST surface for the §3 agent runtime (and cron/integrations).
 * The bootstrap guard is restricted to token exchange. Mutating service
 * commands require a short-lived scoped bearer and retain its agent identity.
 * The batch drain classifies + registers invoices, so it requires the
 * `invoice.ingest` scope (§7.2 — same capability model as tRPC).
 */
@Controller('api/service/agent')
export class AgentController {
  constructor(
    @Inject(AgentCommandService)
    private readonly commands: AgentCommandService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Exchange the bootstrap secret for a scoped, five-minute tRPC bearer. */
  @Post('token')
  @UseGuards(ServiceTokenGuard)
  async token(@Body() body: { runId?: string }) {
    if (body.runId && !/^[a-zA-Z0-9:_-]{1,128}$/.test(body.runId)) {
      throw new BadRequestException('runId contains invalid characters')
    }
    const subject = configuredAgentId()
    const token = issueAgentAccessToken({
      subject,
      scopes: resolveAgentScopes(),
      runId: body.runId,
    })
    await this.audit.record({
      runId: body.runId ?? null,
      actorId: subject,
      actorKind: 'agent',
      action: 'agent.token.issue',
      entity: 'AgentPrincipal',
      entityId: subject,
      after: { expiresAt: token.expiresAt },
    })
    return token
  }

  @Post('batch')
  @UseGuards(AgentAccessTokenGuard)
  async batch(
    @Body() body: { limit?: number; idempotencyKey?: string },
    @Req() request: AgentAccessRequest,
  ) {
    const claims = request.agentClaims
    if (!claims) throw new BadRequestException('Agent claims are unavailable')
    return this.commands.processPending(body.limit ?? 25, {
      id: claims.sub,
      kind: 'agent',
      idempotencyKey: body.idempotencyKey,
      source: 'service-api',
    })
  }
}
