import './no-database'
import { describe, expect, it } from 'vitest'
import {
  currentAgentRunId,
  withAgentRunContext,
} from '../../src/shared/audit/agent-run-context'
import { AuditService } from '../../src/shared/audit/audit.service'
import { AgentRunContextMiddleware } from '../../src/trpc/middlewares/agent-run-context.middleware'

/**
 * §7.1 — every agent action is attributable to the run that produced it.
 * The run id comes from the scoped bearer the API minted for the eve session,
 * so it is bound to the request rather than supplied by the caller.
 */

function fakeTransaction() {
  const created: Array<{ data: { runId: string | null } }> = []
  const tx = {
    created,
    async $executeRaw() {
      return 0
    },
    auditEntry: {
      async findFirst() {
        return null
      },
      async create(args: { data: { runId: string | null } }) {
        created.push(args)
        return args
      },
    },
  }
  return tx as unknown as Parameters<AuditService['record']>[1] & {
    created: typeof created
  }
}

describe('agent run attribution', () => {
  it('records the run id of the agent call in scope', async () => {
    const service = new AuditService()
    const tx = fakeTransaction()

    await withAgentRunContext('wrun_test_1', () =>
      service.record(
        {
          actorId: 'agent-operator',
          actorKind: 'agent',
          action: 'purchaseOrder.issue',
          entity: 'PurchaseOrder',
        },
        tx,
      ),
    )

    expect(tx.created[0]?.data.runId).toBe('wrun_test_1')
  })

  it('leaves human actions without a run id', async () => {
    const service = new AuditService()
    const tx = fakeTransaction()

    await withAgentRunContext('wrun_test_1', () =>
      service.record(
        {
          actorId: 'human-1',
          actorKind: 'human',
          action: 'requisition.create',
          entity: 'Requisition',
        },
        tx,
      ),
    )

    expect(tx.created[0]?.data.runId).toBeNull()
  })

  it('keeps an explicit run id', async () => {
    const service = new AuditService()
    const tx = fakeTransaction()

    await withAgentRunContext('wrun_test_1', () =>
      service.record(
        {
          runId: 'wrun_explicit',
          actorId: 'agent-operator',
          actorKind: 'agent',
          action: 'agent.run.complete',
          entity: 'AgentRun',
        },
        tx,
      ),
    )

    expect(tx.created[0]?.data.runId).toBe('wrun_explicit')
  })

  it('scopes the run id to the agent session of the request', async () => {
    const middleware = new AgentRunContextMiddleware()
    let observed: string | undefined

    await middleware.use({
      ctx: { session: { user: { kind: 'agent', runId: 'wrun_test_2' } } },
      next: async () => {
        observed = currentAgentRunId()
        return { ok: true, data: null }
      },
    } as never)

    expect(observed).toBe('wrun_test_2')
    expect(currentAgentRunId()).toBeUndefined()
  })

  it('gives a human session no run id', async () => {
    const middleware = new AgentRunContextMiddleware()
    let observed: string | undefined

    await middleware.use({
      ctx: { session: { user: { kind: 'human' } } },
      next: async () => {
        observed = currentAgentRunId()
        return { ok: true, data: null }
      },
    } as never)

    expect(observed).toBeUndefined()
  })
})
