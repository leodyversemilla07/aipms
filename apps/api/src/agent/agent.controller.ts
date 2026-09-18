import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common'
import { AgentCommandService } from './agent-command.service'
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
    @Inject(AgentCommandService)
    private readonly commands: AgentCommandService,
  ) {}

  @Post('batch')
  async batch(@Body() body: { limit?: number; idempotencyKey?: string }) {
    return this.commands.processPending(body.limit ?? 25, {
      id: AGENT_ACTOR_ID,
      kind: 'agent',
      idempotencyKey: body.idempotencyKey,
      source: 'service-api',
    })
  }
}
