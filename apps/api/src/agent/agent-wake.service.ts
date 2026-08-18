import { Injectable, OnModuleInit } from '@nestjs/common'
import { db } from '@workspace/db'
import { EventRelayService } from '../shared/events/event-relay.service'
import { AgentService } from './agent.service'

/**
 * §7.3 Agent wake — listens to domain events and spawns an agent run
 * for events that require automated handling. This is a thin orchestrator
 * stub; real skill routing will be expanded in Phase 3+.
 */
@Injectable()
export class AgentWakeService implements OnModuleInit {
  constructor(private readonly relay: EventRelayService, private readonly agent: AgentService) {}

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
    try {
      // Execute minimal domain work for intake events; other events are stubbed for now
      if (event.type === 'intake.received') {
        // Drain up to 5 pending intake docs as a simple batch
        const result = await this.agent.processPending(5)
        console.log(`[agent-wake] run ${run.id} processed ${result.succeeded}/${result.documents} docs`)
        await db.agentRun.update({
          where: { id: run.id },
          data: { status: 'succeeded', finishedAt: new Date(), meta: { ...(run.meta as any), result } },
        })
        return
      }
      // Placeholder for requisition → PO and invoice match flows
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: 'succeeded', finishedAt: new Date() },
      })
    } catch (err) {
      console.error(`[agent-wake] run ${run.id} failed`, err)
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), meta: { ...(run.meta as any), error: (err as Error).message } },
      })
    }
  }
}
