import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common'
import { AuditService } from '../shared/audit/audit.service'
import { agentMayInvoke, resolveAgentScopes } from '../trpc/agent-capabilities'
import { AgentService } from './agent.service'
import { ServiceTokenGuard } from './service-token.guard'

const AGENT_ACTOR_ID = 'agent:service'

/**
 * Machine-facing REST surface for the §3 agent runtime (and cron/integrations).
 * Authenticated by ServiceTokenGuard; audited with actorKind 'agent' so
 * autonomous actions are distinguishable from human ones in the trail.
 * The batch drain classifies + registers invoices, so it requires the
 * `invoice.ingest` scope (§7.2 — same capability model as tRPC).
 */
@Controller('api/service/agent')
@UseGuards(ServiceTokenGuard)
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('batch')
  async batch(@Body() body: { limit?: number }) {
    if (!agentMayInvoke('intake.registerInvoice', resolveAgentScopes())) {
      throw new ForbiddenException(
        'Agent lacks required scope "invoice.ingest" for batch processing',
      )
    }
    const result = await this.agent.processPending(body.limit ?? 25)
    await this.audit.record({
      actorId: AGENT_ACTOR_ID,
      actorKind: 'agent',
      action: 'agent.batch',
      entity: 'IntakeDocument',
      entityId: null,
      input: { limit: body.limit },
      after: result,
    })
    return result
  }
}
