import { createHash, randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AgentRouter } from '../src/agent/agent.router'
import type { AgentService } from '../src/agent/agent.service'
import type { AgentCommandService } from '../src/agent/agent-command.service'
import { AuditService } from '../src/shared/audit/audit.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../src/trpc/context.types'

const actorId = `stale-run-operator-${randomUUID()}`
const runIds: string[] = []
const idempotencyKeys: string[] = []
const router = new AgentRouter(
  {} as AgentService,
  {} as AgentCommandService,
  new IdempotencyService(),
  new AuditService(),
)
const ctx = {
  actorKind: 'human',
  user: { id: actorId, role: 'finance' },
} as AuthedTrpcContext

afterAll(async () => {
  await db.idempotencyKey.deleteMany({
    where: { key: { in: idempotencyKeys } },
  })
  await db.agentRun.deleteMany({ where: { id: { in: runIds } } })
})

function recoveryKey() {
  const supplied = randomUUID()
  idempotencyKeys.push(
    `atomic:v1:${createHash('sha256')
      .update(JSON.stringify([actorId, 'agent.cancelStaleRun', supplied]))
      .digest('hex')}`,
  )
  return supplied
}

describe('stale agent run recovery', () => {
  it('cancels only a stale running execution with audited evidence', async () => {
    const run = await db.agentRun.create({
      data: {
        agentId: `agent-${randomUUID()}`,
        status: 'running',
        skills: ['intake'],
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    })
    runIds.push(run.id)

    const listed = await router.staleRuns({
      q: run.id,
      sort: '',
      dir: 'asc',
      page: 1,
      pageSize: 25,
    })
    expect(listed.rows.map((row) => row.id)).toContain(run.id)

    const cancelled = await router.cancelStaleRun(
      {
        id: run.id,
        idempotencyKey: recoveryKey(),
        reason: 'Worker lease expired and no active process owns this run',
      },
      ctx,
    )
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.finishedAt).not.toBeNull()

    const audit = await db.auditEntry.findFirstOrThrow({
      where: {
        actorId,
        action: 'agent.stale.cancel',
        entityId: run.id,
      },
      orderBy: { seq: 'desc' },
    })
    expect(audit.after).toMatchObject({
      recoveryReason:
        'Worker lease expired and no active process owns this run',
    })
  })

  it('refuses a fresh running execution', async () => {
    const run = await db.agentRun.create({
      data: {
        agentId: `agent-${randomUUID()}`,
        status: 'running',
        skills: ['intake'],
      },
    })
    runIds.push(run.id)

    await expect(
      router.cancelStaleRun(
        {
          id: run.id,
          idempotencyKey: recoveryKey(),
          reason: 'This run is still healthy',
        },
        ctx,
      ),
    ).rejects.toThrow(/not stale and running/)
  })
})
