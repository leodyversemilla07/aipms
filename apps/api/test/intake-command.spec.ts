import { TRPCError } from '@trpc/server'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { IntakeCommandService } from '../src/intake/intake-command.service'

function subject() {
  const ingest = vi.fn(async () => ({
    id: 'doc-1',
    status: 'new',
    channel: 'EMAIL_IMAP',
  }))
  const record = vi.fn(async () => undefined)
  return {
    command: new IntakeCommandService({ ingest } as never, { record } as never),
    ingest,
    record,
  }
}

describe('IntakeCommandService automation boundary', () => {
  it('denies IMAP ingestion when the configured capability is absent', async () => {
    const { command, ingest, record } = subject()
    await expect(
      command.ingest(
        { channel: 'EMAIL_IMAP', contentHash: 'hash-1' },
        {
          id: 'agent:imap-intake',
          kind: 'agent',
          scopes: [],
          source: 'imap',
        },
        {} as Prisma.TransactionClient,
      ),
    ).rejects.toBeInstanceOf(TRPCError)
    expect(ingest).not.toHaveBeenCalled()
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'intake.ingest.denied' }),
    )
  })

  it('audits authorized ingestion in the mutation transaction', async () => {
    const { command, ingest, record } = subject()
    const tx = {} as Prisma.TransactionClient
    await command.ingest(
      { channel: 'EMAIL_IMAP', contentHash: 'hash-1' },
      {
        id: 'agent:imap-intake',
        kind: 'agent',
        scopes: ['intake.ingest'],
        source: 'imap',
        idempotencyKey: 'email:hash-1',
      },
      tx,
    )
    expect(ingest).toHaveBeenCalledWith(
      { channel: 'EMAIL_IMAP', contentHash: 'hash-1' },
      tx,
    )
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'agent:imap-intake',
        action: 'intake.ingest',
        entityId: 'doc-1',
        input: expect.objectContaining({
          idempotencyKey: 'email:hash-1',
        }),
      }),
      tx,
    )
  })
})
