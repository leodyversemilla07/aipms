import './no-database'
import { db, type Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { AuditService } from '../../src/shared/audit/audit.service'

type AuditEntry = Prisma.AuditEntryGetPayload<object>

async function fixture(length: number) {
  const service = new AuditService()
  const rows: AuditEntry[] = []
  const count = vi.fn(
    async () => rows.filter((row) => row.entryHash === null).length,
  )
  const findMany = vi.fn(
    async ({
      where,
      take,
    }: {
      where: { seq?: { gt: number } }
      take: number
    }) => rows.filter((row) => row.seq > (where.seq?.gt ?? 0)).slice(0, take),
  )
  const client = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    auditEntry: {
      count,
      findMany,
      findFirst: vi.fn(async () => rows.at(-1) ?? null),
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
          where: page === 0 ? {} : { seq: { gt: page * 500 } },
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
    expect(findMany.mock.calls[1][0].where).toEqual({ seq: { gt: 1500 } })
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
