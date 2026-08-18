import { Injectable, OnModuleInit } from '@nestjs/common'
import { db } from '@workspace/db'
import { EventRelayService } from '../shared/events/event-relay.service'

/**
 * §7.3 Agent wake — listens to domain events and spawns an agent run
 * for events that require automated handling. This is a thin orchestrator
 * stub; real skill routing will be expanded in Phase 3+.
 */
@Injectable()
export class AgentWakeService implements OnModuleInit {
  constructor(private readonly relay: EventRelayService) {}

  onModuleInit() {
    // Wake on requisition approval → operator agent should issue PO
    this.relay.subscribe('requisition.approved', async (event) => {
      await this.spawnRun('operator', ['requisition-to-po'], event)
    })

    // Wake on invoice received → audit/match agent should process intake
    this.relay.subscribe('invoice.received', async (event) => {
      await this.spawnRun('operator', ['invoice-match'], event)
    })

    // Wake on intake received → classify document
    this.relay.subscribe('intake.received', async (event) => {
      await this.spawnRun('operator', ['intake-classify'], event)
    })
  }

  private async spawnRun(agentId: string, skills: string[], event: any) {
    const run = await db.agentRun.create({
      data: {
        agentId,
        skills,
        meta: {
          triggeredBy: event.type,
          entityType: event.entityType,
          entityId: event.entityId,
          eventId: event.id,
        },
      },
    })
    console.log(`[agent-wake] spawned run ${run.id} for ${event.type}`)
    // In production, enqueue work for the Eve runtime here.
    // For now we mark it succeeded immediately as a stub.
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'succeeded', finishedAt: new Date() },
    })
  }
}
