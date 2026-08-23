import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { EventRelayService } from '../src/shared/events/event-relay.service'

describe('AgentWakeService', () => {
  const agentId = 'operator'
  let relay: EventRelayService
  let wake: AgentWakeService

  beforeEach(async () => {
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.domainEvent.deleteMany({})
    relay = new EventRelayService()
    wake = new AgentWakeService(relay)
    // simulate module init
    wake.onModuleInit()
  })

  afterAll(async () => {
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.domainEvent.deleteMany({})
    await db.$disconnect()
  })

  it('spawns an agent run on requisition.approved', async () => {
    // Seed a domain event in the outbox
    const event = await db.domainEvent.create({
      data: {
        type: 'requisition.approved',
        entityType: 'Requisition',
        entityId: 'req-1',
        payload: { id: 'req-1' },
      },
    })

    // Manually trigger poll
    // @ts-expect-error private
    await (relay as any).poll()

    const runs = await db.agentRun.findMany({ where: { agentId } })
    expect(runs.length).toBeGreaterThan(0)
    const run = runs[0]
    expect(run.skills).toContain('requisition-to-po')
    expect(run.meta).toMatchObject({
      triggeredBy: 'requisition.approved',
      entityId: 'req-1',
    })

    // Event should be marked published
    const updated = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(updated?.publishedAt).not.toBeNull()
  })
})
