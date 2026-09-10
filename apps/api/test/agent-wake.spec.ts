import { db } from '@workspace/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { EventRelayService } from '../src/shared/events/event-relay.service'

describe('AgentWakeService', () => {
  const agentId = 'operator'
  let relay: EventRelayService
  let originalWake: string | undefined

  beforeAll(() => {
    originalWake = process.env.AIPMS_AGENT_WAKE
  })

  beforeEach(async () => {
    process.env.AIPMS_AGENT_WAKE = '1'
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.domainEvent.deleteMany({})
    relay = new EventRelayService()
  })

  afterAll(async () => {
    if (originalWake === undefined) delete process.env.AIPMS_AGENT_WAKE
    else process.env.AIPMS_AGENT_WAKE = originalWake
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.domainEvent.deleteMany({})
    await db.$disconnect()
  })

  it('publishes an intake wake only after the handler succeeds', async () => {
    const wake = new AgentWakeService(
      relay,
      {
        processPending: async () => ({
          documents: 1,
          succeeded: 1,
          failed: [],
        }),
      } as never,
      {} as never,
    )
    wake.onModuleInit()

    const event = await db.domainEvent.create({
      data: {
        type: 'intake.received',
        entityType: 'IntakeDocument',
        entityId: 'doc-1',
        payload: { id: 'doc-1' },
      },
    })

    await relay.poll()

    const run = await db.agentRun.findFirst({ where: { agentId } })
    expect(run?.skills).toContain('intake-classify')
    expect(run?.status).toBe('succeeded')

    const updated = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(updated?.publishedAt).not.toBeNull()
  })

  it('leaves failed wakes unpublished so the relay can retry/dead-letter', async () => {
    const wake = new AgentWakeService(
      relay,
      {
        processPending: async () => {
          throw new Error('extractor offline')
        },
      } as never,
      {} as never,
    )
    wake.onModuleInit()

    const event = await db.domainEvent.create({
      data: {
        type: 'intake.received',
        entityType: 'IntakeDocument',
        entityId: 'doc-2',
        payload: { id: 'doc-2' },
      },
    })

    await relay.poll()

    const updated = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(updated?.publishedAt).toBeNull()
    expect(updated?.attemptCount).toBe(1)
    expect(updated?.lastError).toContain('extractor offline')

    const run = await db.agentRun.findFirst({ where: { agentId } })
    expect(run?.status).toBe('failed')
  })
})
