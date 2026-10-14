import './no-database'
import { ConflictException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentCommandService,
  type CommandActor,
} from '../../src/agent/agent-command.service'
import { AgentWakeService } from '../../src/agent/agent-wake.service'
import type { PurchaseOrderService } from '../../src/purchase-order/purchase-order.service'
import type { IdempotencyService } from '../../src/shared/idempotency/idempotency.service'

interface FakePo {
  id: string
  poNumber: string
  requisitionId: string
  vendorId: string
  status: string
  currencyCode: string
  totalMinor: number
  lines: Array<{
    id: string
    lineNo: number
    description: string
    quantity: number
    unitPriceMinor: number
    lineTotalMinor: number
  }>
}

interface FakeRun {
  id: string
  agentId: string
  skills: string[]
  triggerEventId: string | null
  status: string
  finishedAt: Date | null
  meta: Record<string, unknown>
}

interface RelayEventShape {
  id: string
  type: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
  createdAt: Date
}

describe('Event-Wake PO Crash Recovery (Finding 348)', () => {
  const originalAutorun = process.env.AGENT_AUTORUN

  beforeEach(() => {
    process.env.AGENT_AUTORUN = '1'
  })

  afterEach(() => {
    process.env.AGENT_AUTORUN = originalAutorun
  })

  function makeWakeFixture(initialPo: FakePo | null = null) {
    let currentPo: FakePo | null = initialPo
    const runs = new Map<string, FakeRun>()

    const fakeDb = {
      requisition: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          costCenter: 'IT-OPS',
          budgetId: 'budget-1',
          status: 'approved',
          lines: [
            {
              id: 'line-1',
              description: 'Cloud Servers',
              quantity: 1,
              unitPriceMinor: 5000,
              lineTotalMinor: 5000,
              currencyCode: 'PHP',
            },
          ],
        })),
      },
      purchaseOrder: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { requisitionId: string; status?: { not: string } }
          }) => {
            if (currentPo && currentPo.requisitionId === where.requisitionId) {
              if (where.status?.not && currentPo.status === where.status.not) {
                return null
              }
              return currentPo
            }
            return null
          },
        ),
      },
      budget: {
        findUnique: vi.fn(async () => ({
          id: 'budget-1',
          limitMinor: 1000000,
          committedMinor: 10000,
          spentMinor: 5000,
          currencyCode: 'PHP',
        })),
      },
      policy: {
        findMany: vi.fn(
          async ({ where }: { where: { kind: string; enabled?: boolean } }) => {
            if (where.kind === 'threshold') {
              return [
                {
                  id: 'pol-threshold',
                  version: 1,
                  enabled: true,
                  kind: 'threshold',
                  name: 'Default threshold',
                  config: { autoApproveUpTo: 100000 },
                  createdAt: new Date(),
                },
              ]
            }
            if (where.kind === 'preferredVendor') {
              return [
                {
                  id: 'pol-preferred',
                  version: 1,
                  enabled: true,
                  kind: 'preferredVendor',
                  name: 'Default preferred vendor',
                  config: { vendorId: 'vendor-1' },
                  createdAt: new Date(),
                },
              ]
            }
            return []
          },
        ),
      },
      quote: {
        findFirst: vi.fn(async () => null),
      },
      vendor: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (where.id === 'vendor-1') {
            return {
              id: 'vendor-1',
              name: 'Acme Cloud',
              status: 'active',
            }
          }
          return null
        }),
        findFirst: vi.fn(async () => ({
          id: 'vendor-1',
          name: 'Acme Cloud',
          status: 'active',
        })),
      },
      agentRun: {
        create: vi.fn(
          async ({ data }: { data: Prisma.AgentRunCreateInput }) => {
            const id = `run-${runs.size + 1}`
            const row: FakeRun = {
              id,
              agentId: data.agentId,
              skills: data.skills as string[],
              triggerEventId: data.triggerEventId ?? null,
              status: 'running',
              finishedAt: null,
              meta: (data.meta as Record<string, unknown>) ?? {},
            }
            runs.set(id, row)
            return row
          },
        ),
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { triggerEventId?: string; id?: string }
          }) => {
            if (where.id) return runs.get(where.id) ?? null
            if (where.triggerEventId) {
              for (const r of runs.values()) {
                if (r.triggerEventId === where.triggerEventId) return r
              }
            }
            return null
          },
        ),
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string }
            data: Partial<FakeRun>
          }) => {
            const existing = runs.get(where.id)
            if (!existing) throw new Error(`Run ${where.id} not found`)
            Object.assign(existing, data)
            return existing
          },
        ),
      },
    }

    const handlers = new Map<
      string,
      (event: RelayEventShape) => Promise<void>
    >()
    const fakeRelay = {
      subscribe: vi.fn(
        (type: string, handler: (event: RelayEventShape) => Promise<void>) => {
          handlers.set(type, handler)
        },
      ),
    }

    return {
      fakeDb,
      fakeRelay,
      runs,
      handlers,
      setCurrentPo: (po: FakePo | null) => {
        currentPo = po
      },
    }
  }

  it('recovers already-issued PO when uncancelled PO exists before wake execution', async () => {
    const existingPo: FakePo = {
      id: 'po-recovered-1',
      poNumber: 'PO-2026-0001',
      requisitionId: 'req-1',
      vendorId: 'vendor-1',
      status: 'issued',
      currencyCode: 'PHP',
      totalMinor: 5000,
      lines: [
        {
          id: 'poline-1',
          lineNo: 1,
          description: 'Cloud Servers',
          quantity: 1,
          unitPriceMinor: 5000,
          lineTotalMinor: 5000,
        },
      ],
    }

    const { fakeDb, fakeRelay, runs, handlers } = makeWakeFixture(existingPo)
    const issuePurchaseOrder = vi.fn()
    const fakeCommands = {
      issuePurchaseOrder,
      processDocument: vi.fn(),
      processPending: vi.fn(),
    } as unknown as AgentCommandService

    const wake = new AgentWakeService(
      fakeRelay as never,
      fakeCommands,
      fakeDb as never,
    )

    // Trigger requisition.approved wake
    const event = {
      id: 'evt-approved-1',
      type: 'requisition.approved',
      entityType: 'Requisition',
      entityId: 'req-1',
      payload: {},
      createdAt: new Date(),
    }

    // Call private handleRequisitionApproved via subscription
    wake.onModuleInit()
    const handler = handlers.get('requisition.approved')
    expect(handler).toBeDefined()
    if (!handler) throw new Error('Missing handler')
    await handler(event)

    // Commands should NOT have been called because PO was recovered
    expect(issuePurchaseOrder).not.toHaveBeenCalled()

    // Agent run should be settled as succeeded with recovered flag
    const run = Array.from(runs.values())[0]
    expect(run).toBeDefined()
    expect(run.status).toBe('succeeded')
    expect(run.meta).toMatchObject({
      recovered: true,
      result: {
        outcome: 'ISSUED',
        purchaseOrderId: 'po-recovered-1',
        poNumber: 'PO-2026-0001',
      },
    })
  })

  it('recovers already-issued PO when issue throws ConflictException(already has a purchase order)', async () => {
    const { fakeDb, fakeRelay, runs, handlers, setCurrentPo } =
      makeWakeFixture(null)

    // Simulate conflict: PO did not exist at first read, but was committed by another attempt/worker
    const conflictPo: FakePo = {
      id: 'po-conflict-1',
      poNumber: 'PO-2026-0099',
      requisitionId: 'req-1',
      vendorId: 'vendor-1',
      status: 'issued',
      currencyCode: 'PHP',
      totalMinor: 5000,
      lines: [],
    }

    const issuePurchaseOrder = vi.fn().mockImplementation(async () => {
      // Simulate that by the time issue is called, the PO was committed
      setCurrentPo(conflictPo)
      throw new ConflictException('Requisition already has a purchase order')
    })

    const fakeCommands = {
      issuePurchaseOrder,
      processDocument: vi.fn(),
      processPending: vi.fn(),
    } as unknown as AgentCommandService

    const wake = new AgentWakeService(
      fakeRelay as never,
      fakeCommands,
      fakeDb as never,
    )

    wake.onModuleInit()
    const handler = handlers.get('requisition.approved')
    expect(handler).toBeDefined()
    if (!handler) throw new Error('Missing handler')

    const event = {
      id: 'evt-approved-2',
      type: 'requisition.approved',
      entityType: 'Requisition',
      entityId: 'req-1',
      payload: {},
      createdAt: new Date(),
    }

    // Should complete cleanly without throwing ConflictException
    await expect(handler(event)).resolves.not.toThrow()

    // Run was marked succeeded with recovery metadata
    const run = Array.from(runs.values())[0]
    expect(run.status).toBe('succeeded')
    expect(run.meta).toMatchObject({
      recovered: true,
      result: {
        outcome: 'ISSUED',
        purchaseOrderId: 'po-conflict-1',
        poNumber: 'PO-2026-0099',
      },
    })
  })

  it('fails and rethrows non-conflict errors so outbox relay can retry or dead-letter', async () => {
    const { fakeDb, fakeRelay, runs, handlers } = makeWakeFixture(null)

    const issuePurchaseOrder = vi
      .fn()
      .mockRejectedValue(new Error('Transient database timeout'))

    const fakeCommands = {
      issuePurchaseOrder,
      processDocument: vi.fn(),
      processPending: vi.fn(),
    } as unknown as AgentCommandService

    const wake = new AgentWakeService(
      fakeRelay as never,
      fakeCommands,
      fakeDb as never,
    )

    wake.onModuleInit()
    const handler = handlers.get('requisition.approved')
    expect(handler).toBeDefined()
    if (!handler) throw new Error('Missing handler')

    const event = {
      id: 'evt-approved-3',
      type: 'requisition.approved',
      entityType: 'Requisition',
      entityId: 'req-1',
      payload: {},
      createdAt: new Date(),
    }

    await expect(handler(event)).rejects.toThrow('Transient database timeout')

    const run = Array.from(runs.values())[0]
    expect(run.status).toBe('failed')
    expect(run.meta).toMatchObject({
      error: 'Transient database timeout',
    })
  })

  describe('AgentCommandService Idempotency Integration', () => {
    it('executes within runAtomic when actor.idempotencyKey is supplied', async () => {
      const mockResult = {
        outcome: 'ISSUED' as const,
        purchaseOrder: {
          id: 'po-atomic-1',
          poNumber: 'PO-ATOMIC-001',
        },
      }

      const issue = vi.fn(async () => mockResult)
      const record = vi.fn(async () => undefined)
      const runAtomic = vi.fn(
        async (
          _scope: unknown,
          fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) => {
          return fn({} as Prisma.TransactionClient)
        },
      )
      const idempotency = { runAtomic } as unknown as IdempotencyService

      const commandService = new AgentCommandService(
        {} as never,
        { issue } as unknown as PurchaseOrderService,
        { record } as never,
        {
          run: async (
            _actor: unknown,
            _op: string,
            task: () => Promise<unknown>,
          ) => task(),
        } as never,
        idempotency,
      )

      const actor: CommandActor = {
        id: 'agent:operator',
        kind: 'agent',
        scopes: ['po.issue'],
        runId: 'run-atomic-1',
        idempotencyKey: 'event:evt-1234',
        source: 'event-wake',
      }

      const result = await commandService.issuePurchaseOrder(
        { requisitionId: 'req-1', vendorId: 'vendor-1', terms: {} },
        actor,
      )

      expect(runAtomic).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'agent:operator',
          operation: 'purchaseOrder.issue',
          key: 'event:evt-1234',
        }),
        expect.any(Function),
      )
      expect(issue).toHaveBeenCalled()
      expect(result).toEqual(mockResult)
    })

    it('returns memoized result on replay without re-issuing PO', async () => {
      const cachedResult = {
        outcome: 'ISSUED' as const,
        purchaseOrder: {
          id: 'po-cached-1',
          poNumber: 'PO-CACHED-001',
        },
      }

      const issue = vi.fn()
      // Simulate runAtomic returning cached outcome directly without running callback
      const runAtomic = vi.fn(async () => cachedResult)
      const idempotency = { runAtomic } as unknown as IdempotencyService

      const commandService = new AgentCommandService(
        {} as never,
        { issue } as unknown as PurchaseOrderService,
        { record: vi.fn() } as never,
        {
          run: async (
            _actor: unknown,
            _op: string,
            task: () => Promise<unknown>,
          ) => task(),
        } as never,
        idempotency,
      )

      const actor: CommandActor = {
        id: 'agent:operator',
        kind: 'agent',
        scopes: ['po.issue'],
        runId: 'run-retry-2',
        idempotencyKey: 'event:evt-1234',
        source: 'event-wake',
      }

      const result = await commandService.issuePurchaseOrder(
        { requisitionId: 'req-1', vendorId: 'vendor-1', terms: {} },
        actor,
      )

      expect(runAtomic).toHaveBeenCalled()
      // Domain PO issue must NOT have been called because result was memoized
      expect(issue).not.toHaveBeenCalled()
      expect(result).toEqual(cachedResult)
    })
  })
})
