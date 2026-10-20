import './no-database'
import { db, type Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { AuditService } from '../../src/shared/audit/audit.service'

type AuditEntry = Prisma.AuditEntryGetPayload<object>

async function fixture(length: number) {
  const service = new AuditService()
  const rows: AuditEntry[] = []
  const count = vi.fn(
    async (args?: { where?: { entryHash?: null | { not: null } } }) => {
      if (args?.where?.entryHash === null) {
        return rows.filter((row) => row.entryHash === null).length
      }
      if (args?.where?.entryHash) {
        return rows.filter((row) => row.entryHash !== null).length
      }
      return rows.length
    },
  )
  const findMany = vi.fn(
    async ({
      where,
      take,
    }: {
      where: { seq?: { gt?: number; lte?: number } }
      take: number
    }) =>
      rows
        .filter(
          (row) =>
            row.seq > (where.seq?.gt ?? 0) &&
            row.seq <= (where.seq?.lte ?? Number.POSITIVE_INFINITY),
        )
        .slice(0, take),
  )
  const client = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    auditEntry: {
      count,
      findMany,
      findFirst: vi.fn(
        async (args?: {
          where?: { seq?: number; entryHash?: { not: null } }
        }) => {
          if (typeof args?.where?.seq === 'number') {
            return rows.find((row) => row.seq === args.where?.seq) ?? null
          }
          if (args?.where?.entryHash) {
            return rows.filter((row) => row.entryHash !== null).at(-1) ?? null
          }
          return rows.at(-1) ?? null
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<AuditEntry, 'seq'> }) => {
        const row = {
          ...data,
          before: data.before ?? null,
          after: data.after ?? null,
          seq: rows.length + 1,
        }
        rows.push(row)
        return row
      }),
    },
  } as unknown as Prisma.TransactionClient
  for (let i = 0; i < length; i++) {
    // Build hashes using the real writer, but never connect to PostgreSQL.
    await service.record(
      {
        actorId: 'unit-auditor',
        actorKind: 'human',
        action: `fixture.${i}`,
        entity: 'UnitFixture',
        entityId: `${i}`,
      },
      client,
    )
  }
  return { service, client, rows, count, findMany }
}

describe('bounded audit verification with injected clients', () => {
  it('fails closed if a unit test accesses the default database client', () => {
    expect(() => db.auditEntry).toThrow(
      'Unit tests cannot access db.auditEntry',
    )
  })

  it.each([0, 1, 499, 500, 501, 1000, 1001])(
    'verifies %i real hashes across page boundaries',
    async (length) => {
      const { service, client, findMany } = await fixture(length)
      expect(await service.verifyChain(client)).toEqual({
        ok: true,
        checked: length,
        legacy: 0,
      })
      expect(findMany).toHaveBeenCalledTimes(Math.floor(length / 500) + 1)
      for (let page = 0; page < findMany.mock.calls.length; page++) {
        expect(findMany.mock.calls[page][0]).toMatchObject({
          take: 500,
          orderBy: { seq: 'asc' },
          where: {
            seq: {
              gt: page === 0 ? undefined : page * 500,
              lte: length || undefined,
            },
          },
        })
      }
    },
  )

  it('continues by the last sequence, not the number of verified rows', async () => {
    const { service, client, rows, findMany } = await fixture(501)
    for (const row of rows) row.seq *= 3
    expect(await service.verifyChain(client)).toEqual({
      ok: true,
      checked: 501,
      legacy: 0,
    })
    expect(findMany.mock.calls[1][0].where).toEqual({
      seq: { gt: 1500, lte: 1503 },
    })
  })

  it('pins the walk to the head captured before paging', async () => {
    const { service, client, rows, findMany } = await fixture(3)
    const findFirst = client.auditEntry.findFirst as unknown as ReturnType<
      typeof vi.fn
    >
    // A concurrent writer appends between head capture and page reads; its
    // entry belongs to the next verification, never this walk.
    findFirst.mockImplementationOnce(async () => {
      const head = rows.at(-1)
      await service.record(
        {
          actorId: 'unit-writer',
          actorKind: 'human',
          action: 'fixture.late',
          entity: 'UnitFixture',
        },
        client,
      )
      return { seq: head.seq }
    })
    expect(await service.verifyChain(client)).toEqual({
      ok: true,
      checked: 3,
      legacy: 0,
    })
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(4) // the late entry exists but was never visited
  })

  it('detects content tampering immediately after the first full page', async () => {
    const { service, client, rows, findMany } = await fixture(501)
    rows[500].action = 'tampered'
    expect(await service.verifyChain(client)).toMatchObject({
      ok: false,
      checked: 501,
      legacy: 0,
      brokenAtSeq: 501,
      reason: 'entry content no longer matches its committed hash',
    })
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('detects a broken predecessor link across pages', async () => {
    const { service, client, rows } = await fixture(501)
    rows[500].prevHash = 'wrong-predecessor'
    expect(await service.verifyChain(client)).toMatchObject({
      ok: false,
      checked: 501,
      brokenAtSeq: 501,
      reason: 'prevHash does not match the preceding chained entry',
    })
  })

  it('counts all legacy rows even when failure happens on the first page', async () => {
    const { service, client, rows, count, findMany } = await fixture(501)
    for (const row of rows.slice(1)) row.entryHash = null
    rows[0].action = 'tampered'
    expect(await service.verifyChain(client)).toMatchObject({
      ok: false,
      checked: 1,
      legacy: 500,
      brokenAtSeq: 1,
    })
    expect(count).toHaveBeenCalledWith({ where: { entryHash: null } })
    expect(findMany).toHaveBeenCalledOnce()
  })
})

describe('retained checkpoint comparison', () => {
  /** The hash a chained fixture row committed to. */
  function hashOf(row: AuditEntry | undefined): string {
    if (!row?.entryHash) throw new Error('fixture row carries no hash')
    return row.entryHash
  }

  it('issues the current head as a checkpoint', async () => {
    const { service, client, rows } = await fixture(3)
    const head = rows.at(-1)
    if (!head) throw new Error('fixture produced no rows')
    expect(await service.checkpoint(client)).toEqual({
      seq: head.seq,
      entryHash: head.entryHash,
      at: head.at.toISOString(),
      total: 3,
    })
  })

  it('reports an advanced trail when the checkpointed entry is intact', async () => {
    const { service, client, rows } = await fixture(3)
    const result = await service.verifyChain(client, {
      seq: 2,
      entryHash: hashOf(rows[1]),
    })
    expect(result.ok).toBe(true)
    expect(result.checkpoint).toMatchObject({
      status: 'advanced',
      expectedSeq: 2,
      currentSeq: 3,
    })
  })

  it('reports truncation when the trail tip was removed', async () => {
    const { service, client, rows } = await fixture(3)
    const checkpoint = { seq: 3, entryHash: hashOf(rows[2]) }
    // The tip disappears: the remaining chain is still internally consistent.
    rows.pop()
    const result = await service.verifyChain(client, checkpoint)
    expect(result.ok).toBe(false)
    expect(result.checkpoint).toMatchObject({
      status: 'truncated',
      expectedSeq: 3,
      currentSeq: 2,
    })
    expect(result.reason).toContain('behind the retained checkpoint')
  })

  it('reports a rewritten checkpointed entry', async () => {
    const { service, client, rows } = await fixture(3)
    const checkpoint = { seq: 2, entryHash: hashOf(rows[1]) }
    rows[1].entryHash = 'rewritten-hash'
    const result = await service.verifyChain(client, checkpoint)
    expect(result.ok).toBe(false)
    expect(result.checkpoint).toMatchObject({
      status: 'rewritten',
      expectedSeq: 2,
      currentSeq: 3,
    })
  })

  it('reports a missing checkpointed entry', async () => {
    const { service, client, rows } = await fixture(3)
    const checkpoint = { seq: 2, entryHash: hashOf(rows[1]) }
    // A hole in the middle: the entry the checkpoint vouches for is gone.
    rows.splice(1, 1)
    const result = await service.verifyChain(client, checkpoint)
    expect(result.ok).toBe(false)
    expect(result.checkpoint).toMatchObject({
      status: 'missing',
      expectedSeq: 2,
    })
  })

  it('leaves verification untouched when no checkpoint is supplied', async () => {
    const { service, client } = await fixture(3)
    expect(await service.verifyChain(client)).toEqual({
      ok: true,
      checked: 3,
      legacy: 0,
    })
  })
})
