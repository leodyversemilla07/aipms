import { db } from '@workspace/db'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { configuredAgentId } from '../src/agent/agent-principal'
import { AgentRuntimeService } from '../src/agent/agent-runtime.service'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { EventRelayService } from '../src/shared/events/event-relay.service'

describe('AgentWakeService', () => {
  const agentId = 'operator'
  let relay: EventRelayService
  let originalWake: string | undefined
  let originalEveWake: string | undefined

  /** The eve runtime is not configured unless a case says otherwise. */
  const runtime = {
    isConfigured: () => false,
    wake: async () => ({ sessionId: 'wrun_unused' }),
  } as unknown as AgentRuntimeService

  beforeAll(() => {
    originalWake = process.env.AIPMS_AGENT_WAKE
    originalEveWake = process.env.AIPMS_AGENT_EVE_WAKE
  })

  beforeEach(async () => {
    process.env.AIPMS_AGENT_WAKE = '1'
    delete process.env.AIPMS_AGENT_EVE_WAKE
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.agentRun.deleteMany({ where: { agentId: configuredAgentId() } })
    await db.domainEvent.deleteMany({})
    relay = new EventRelayService()
  })

  afterAll(async () => {
    if (originalWake === undefined) delete process.env.AIPMS_AGENT_WAKE
    else process.env.AIPMS_AGENT_WAKE = originalWake
    if (originalEveWake === undefined) delete process.env.AIPMS_AGENT_EVE_WAKE
    else process.env.AIPMS_AGENT_EVE_WAKE = originalEveWake
    await db.agentRun.deleteMany({ where: { agentId } })
    await db.agentRun.deleteMany({ where: { agentId: configuredAgentId() } })
    await db.domainEvent.deleteMany({})
    await db.$disconnect()
  })

  it('publishes an intake wake only after the handler succeeds', async () => {
    const wake = new AgentWakeService(
      relay,
      {
        processDocument: async () => ({
          doc: { status: 'matched' },
          invoice: { id: 'invoice-1' },
          match: { outcome: 'PASS' },
        }),
      } as never,
      runtime,
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

  it('does not invent an invoice-match run for already-matched invoices', async () => {
    const wake = new AgentWakeService(relay, {} as never, runtime)
    wake.onModuleInit()
    const event = await db.domainEvent.create({
      data: {
        type: 'invoice.received',
        entityType: 'Invoice',
        entityId: 'invoice-1',
        payload: {},
      },
    })

    await relay.poll()
    expect(
      (await db.domainEvent.findUnique({ where: { id: event.id } }))
        ?.publishedAt,
    ).not.toBeNull()
    expect(
      await db.agentRun.count({ where: { triggerEventId: event.id } }),
    ).toBe(0)
  })

  it('leaves failed wakes unpublished so the relay can retry/dead-letter', async () => {
    const wake = new AgentWakeService(
      relay,
      {
        processDocument: async () => {
          throw new Error('extractor offline')
        },
      } as never,
      runtime,
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

  it('wakes the eve runtime and records the session as the agent run', async () => {
    process.env.AIPMS_AGENT_EVE_WAKE = '1'
    const wakeCalls: Array<{ message: string; operationId: string }> = []
    const processDocument = vi.fn()
    const eveRuntime = {
      isConfigured: () => true,
      wake: async (input: { message: string; operationId: string }) => {
        wakeCalls.push(input)
        return { sessionId: 'wrun_test_1', deliveryId: 'delivery_1' }
      },
    } as unknown as AgentRuntimeService

    const wake = new AgentWakeService(
      relay,
      { processDocument } as never,
      eveRuntime,
    )
    wake.onModuleInit()

    const event = await db.domainEvent.create({
      data: {
        type: 'intake.received',
        entityType: 'IntakeDocument',
        entityId: 'doc-eve-1',
        payload: { id: 'doc-eve-1' },
      },
    })

    await relay.poll()

    // The eve runtime owns the wake: the in-process pipeline must not act.
    expect(processDocument).not.toHaveBeenCalled()
    expect(wakeCalls).toHaveLength(1)
    expect(wakeCalls[0]?.operationId).toBe(`wake:${event.id}`)
    expect(wakeCalls[0]?.message).toContain('doc-eve-1')

    const run = await db.agentRun.findUnique({ where: { id: 'wrun_test_1' } })
    expect(run?.agentId).toBe(configuredAgentId())
    expect(run?.triggerEventId).toBe(event.id)
    expect(run?.status).toBe('running')
    const meta = run?.meta as {
      delivery?: { channel?: string; sessionId?: string; deliveryId?: string }
    }
    expect(meta.delivery).toMatchObject({
      channel: 'eve',
      sessionId: 'wrun_test_1',
      deliveryId: 'delivery_1',
    })

    const updated = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(updated?.publishedAt).not.toBeNull()
  })

  it('leaves the event unpublished when the eve runtime refuses the wake', async () => {
    process.env.AIPMS_AGENT_EVE_WAKE = '1'
    const eveRuntime = {
      isConfigured: () => true,
      wake: async () => {
        throw new Error('agent runtime offline')
      },
    } as unknown as AgentRuntimeService

    const wake = new AgentWakeService(relay, {} as never, eveRuntime)
    wake.onModuleInit()

    const event = await db.domainEvent.create({
      data: {
        type: 'intake.received',
        entityType: 'IntakeDocument',
        entityId: 'doc-eve-2',
        payload: { id: 'doc-eve-2' },
      },
    })

    await relay.poll()

    const updated = await db.domainEvent.findUnique({ where: { id: event.id } })
    expect(updated?.publishedAt).toBeNull()
    expect(updated?.lastError).toContain('agent runtime offline')
    expect(
      await db.agentRun.count({ where: { triggerEventId: event.id } }),
    ).toBe(0)
  })
})
