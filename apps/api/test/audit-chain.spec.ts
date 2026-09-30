import { randomUUID } from 'node:crypto'
import { db, type Prisma } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'

/**
 * Audit history is append-only, including in tests. Each test uses its own
 * entity; destructive probes run inside a rolled-back transaction so they
 * cannot break the global chain for later integration specs.
 */
const service = new AuditService()
let probeEntity: string

function record(
  action: string,
  extra: Record<string, unknown> = {},
  tx?: Prisma.TransactionClient,
) {
  return service.record(
    {
      actorId: 'chain-tester',
      actorKind: 'human',
      action,
      entity: probeEntity,
      entityId: 'probe-1',
      ...extra,
    },
    tx,
  )
}

async function withRollback(
  action: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  const rollback = new Error('rollback audit integrity probe')
  try {
    await db.$transaction(async (tx) => {
      await action(tx)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
}

describe('Audit chain', () => {
  beforeEach(() => {
    probeEntity = `ChainProbe:${randomUUID()}`
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('rejects update and delete outside explicit maintenance mode', async () => {
    await record('immutable.probe')
    const row = await db.auditEntry.findFirstOrThrow({
      where: { action: 'immutable.probe', entity: probeEntity },
    })
    await expect(
      db.auditEntry.update({
        where: { id: row.id },
        data: { action: 'immutable.changed' },
      }),
    ).rejects.toThrow(/append-only/)
    await expect(
      db.auditEntry.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/append-only/)
  })

  it('links sequential records', async () => {
    await record('a.first')
    await record('a.second')
    await record('a.third')

    const rows = await db.auditEntry.findMany({
      where: { entity: probeEntity },
      orderBy: { seq: 'asc' },
    })
    expect(rows).toHaveLength(3)
    expect(rows[1].prevHash).toBe(rows[0].entryHash)
    expect(rows[2].prevHash).toBe(rows[1].entryHash)

    const result = await service.verifyChain()
    expect(result.ok).toBe(true)
    expect(result.checked).toBeGreaterThanOrEqual(3)
  })

  it('survives concurrent writers without forking', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => record(`c.parallel-${i}`)),
    )

    const rows = await db.auditEntry.findMany({
      where: { entity: probeEntity },
      orderBy: { seq: 'asc' },
    })
    expect(rows).toHaveLength(10)
    expect((await service.verifyChain()).ok).toBe(true)
  })

  it('persists run identity in the hash and detects trace tampering', async () => {
    await withRollback(async (tx) => {
      await record('run.linked', { runId: 'run-original' }, tx)
      const row = await tx.auditEntry.findFirstOrThrow({
        where: { action: 'run.linked', entity: probeEntity },
      })
      expect(row.runId).toBe('run-original')
      expect((await service.verifyChain(tx)).ok).toBe(true)

      await tx.$executeRaw`SELECT set_config('aipms.allow_audit_mutation', 'on', true)`
      await tx.$executeRaw`UPDATE "AuditEntry" SET "runId" = 'run-tampered' WHERE id = ${row.id}`
      const result = await service.verifyChain(tx)
      expect(result.ok).toBe(false)
      expect(result.brokenAtSeq).toBe(row.seq)
    })
  })

  it('detects a tampered entry', async () => {
    await withRollback(async (tx) => {
      await record('t.one', {}, tx)
      await record('t.two', {}, tx)
      await record('t.three', {}, tx)
      const victim = await tx.auditEntry.findFirstOrThrow({
        where: { action: 't.two', entity: probeEntity },
      })
      await tx.$executeRaw`SELECT set_config('aipms.allow_audit_mutation', 'on', true)`
      await tx.$executeRaw`UPDATE "AuditEntry" SET action = 't.evil' WHERE id = ${victim.id}`

      const result = await service.verifyChain(tx)
      expect(result.ok).toBe(false)
      expect(result.brokenAtSeq).toBe(victim.seq)
      expect(result.reason).toMatch(/no longer matches/)
    })
  })

  it('detects a deleted entry', async () => {
    await withRollback(async (tx) => {
      await record('d.one', {}, tx)
      await record('d.two', {}, tx)
      await record('d.three', {}, tx)
      const victim = await tx.auditEntry.findFirstOrThrow({
        where: { action: 'd.two', entity: probeEntity },
      })
      await tx.$executeRaw`SELECT set_config('aipms.allow_audit_mutation', 'on', true)`
      await tx.auditEntry.delete({ where: { id: victim.id } })

      const result = await service.verifyChain(tx)
      expect(result.ok).toBe(false)
      expect(result.brokenAtSeq).toBeDefined()
      expect(result.reason).toMatch(/preceding chained entry/)
    })
  })

  it('reads bounded keyset pages and verifies across a page boundary', async () => {
    const rows: { seq: number; entryHash: string | null }[] = Array.from(
      { length: 501 },
      (_, index) => ({
        seq: index + 1,
        entryHash: null,
      }),
    )
    rows.push({ seq: 502, entryHash: 'unexpected-hash' })
    const count = vi.fn().mockResolvedValue(501)
    const findMany = vi.fn(
      async ({
        where,
        take,
      }: {
        where: { seq?: { gt: number } }
        take: number
      }) => {
        expect(take).toBe(500)
        return rows
          .filter((row) => row.seq > (where.seq?.gt ?? 0))
          .slice(0, take)
      },
    )
    const client = {
      auditEntry: { count, findMany },
    } as unknown as Prisma.TransactionClient

    const result = await service.verifyChain(client)
    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      legacy: 501,
      brokenAtSeq: 502,
    })
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(findMany.mock.calls[1][0].where).toEqual({ seq: { gt: 500 } })
    expect(count).toHaveBeenCalledWith({ where: { entryHash: null } })
  })

  it('skips legacy (null-hash) rows', async () => {
    await withRollback(async (tx) => {
      await tx.$executeRaw`INSERT INTO "AuditEntry" (id, "actorId", "actorKind", action, entity, at) VALUES (${`legacy-${randomUUID()}`}, 'old', 'human', 'legacy.action', ${probeEntity}, now())`
      await record('l.after-legacy', {}, tx)

      const result = await service.verifyChain(tx)
      expect(result.ok).toBe(true)
      expect(result.legacy).toBeGreaterThan(0)
    })
  })
})
