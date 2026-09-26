import { TRPCError } from '@trpc/server'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { AgentCommandService } from '../src/agent/agent-command.service'

function subject() {
  const classifyAndRegister = vi.fn(async () => ({
    doc: { status: 'matched' },
    invoice: { id: 'invoice-1' },
    match: { outcome: 'PASS' },
  }))
  const issue = vi.fn()
  const record = vi.fn(async () => undefined)
  return {
    command: new AgentCommandService(
      { classifyAndRegister } as never,
      { issue } as never,
      { record } as never,
    ),
    classifyAndRegister,
    issue,
    record,
  }
}

describe('AgentCommandService authorization and audit boundary', () => {
  it('rejects an automated command before domain code when scope is absent', async () => {
    const { command, classifyAndRegister, record } = subject()
    await expect(
      command.processDocument(
        'doc-1',
        {
          id: 'agent:scheduler',
          kind: 'agent',
          scopes: [],
          source: 'scheduler',
        },
        {} as Prisma.TransactionClient,
      ),
    ).rejects.toBeInstanceOf(TRPCError)
    expect(classifyAndRegister).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.process.denied',
        entity: 'Authorization',
      }),
    )
  })

  it('runs and audits an authorized command in the caller transaction', async () => {
    const { command, classifyAndRegister, record } = subject()
    const tx = {} as Prisma.TransactionClient
    const result = await command.processDocument(
      'doc-1',
      {
        id: 'agent:operator',
        kind: 'agent',
        scopes: ['invoice.ingest'],
        runId: 'run-1',
        source: 'event-wake',
      },
      tx,
    )

    expect(result.invoice).toMatchObject({ id: 'invoice-1' })
    expect(classifyAndRegister).toHaveBeenCalledWith('doc-1', tx)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        actorId: 'agent:operator',
        actorKind: 'agent',
        action: 'agent.process',
        entityId: 'doc-1',
      }),
      tx,
    )
  })

  it('applies the centralized human policy to direct command use', async () => {
    const { command, classifyAndRegister, record } = subject()
    await expect(
      command.processDocument(
        'doc-1',
        {
          id: 'plain-user',
          kind: 'human',
          role: 'user',
          source: 'trpc',
        },
        {} as Prisma.TransactionClient,
      ),
    ).rejects.toBeInstanceOf(TRPCError)
    expect(classifyAndRegister).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.process.denied' }),
    )
  })
})
