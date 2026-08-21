import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'

/**
 * §16.3 tamper-evident audit chain: entries hash-link to their predecessor;
 * edits, deletions, and concurrent writers are all handled.
 */

const service = new AuditService()

function record(action: string, extra: Record<string, unknown> = {}) {
  return service.record({
    actorId: 'chain-tester',
    actorKind: 'human',
    action,
    entity: 'ChainProbe',
    entityId: 'probe-1',
    ...extra,
  })
}

describe('Audit chain', () => {
  beforeEach(async () => {
    await db.auditEntry.deleteMany({ where: { entity: 'ChainProbe' } })
  })

  afterAll(async () => {
    await db.auditEntry.deleteMany({ where: { entity: 'ChainProbe' } })
    await db.$disconnect()
  })

  it('links sequential records', async () => {
    await record('a.first')
    await record('a.second')
    await record('a.third')

    const rows = await db.auditEntry.findMany({
      where: { entity: 'ChainProbe' },
      orderBy: { seq: 'asc' },
    })
    expect(rows).toHaveLength(3)
    // Relative linkage holds regardless of what other suites wrote.
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
      where: { entity: 'ChainProbe' },
      orderBy: { seq: 'asc' },
    })
    expect(rows).toHaveLength(10)

    const result = await service.verifyChain()
    expect(result.ok).toBe(true)
  })

  it('detects a tampered entry', async () => {
    await record('t.one')
    await record('t.two')
    await record('t.three')

    // Rewrite history behind the API's back.
    const victim = await db.auditEntry.findFirstOrThrow({
      where: { action: 't.two' },
    })
    await db.$executeRaw`UPDATE "AuditEntry" SET action = 't.evil' WHERE id = ${victim.id}`

    const result = await service.verifyChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAtSeq).toBe(victim.seq)
    expect(result.reason).toMatch(/no longer matches/)
  })

  it('detects a deleted entry', async () => {
    await record('d.one')
    await record('d.two')
    await record('d.three')

    const victim = await db.auditEntry.findFirstOrThrow({
      where: { action: 'd.two' },
    })
    await db.auditEntry.delete({ where: { id: victim.id } })

    const result = await service.verifyChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAtSeq).toBeDefined()
    expect(result.reason).toMatch(/preceding chained entry/)
  })

  it('skips legacy (null-hash) rows', async () => {
    // Simulate a pre-feature row.
    await db.$executeRaw`INSERT INTO "AuditEntry" (id, "actorId", "actorKind", action, entity, at) VALUES ('legacy-1', 'old', 'human', 'legacy.action', 'ChainProbe', now())`

    await record('l.after-legacy')

    const result = await service.verifyChain()
    expect(result.ok).toBe(true)
    expect(result.legacy).toBeGreaterThan(0)
  })
})
