import { randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'

const service = new IdempotencyService()
const audit = new AuditService()
const prefix = randomUUID()
const scope = (key: string) => ({
  actorId: prefix,
  operation: 'test',
  key,
  input: { amount: 1 },
})
afterAll(async () => {
  // This spec shares the database with seed-dependent suites that assume
  // findFirst() returns demo data: remove everything this file created.
  await db.auditEntry.deleteMany({ where: { actorId: prefix } })
  await db.budget.deleteMany({ where: { costCenter: prefix } })
  await db.$disconnect()
})

describe('atomic idempotency (isolated database)', () => {
  it('rolls back domain, audit and key on failure, then permits retry', async () => {
    const target = scope('rollback')
    const action = async (fail: boolean) =>
      service.runAtomic(target, async (tx) => {
        const row = await tx.budget.create({
          data: {
            name: prefix,
            costCenter: prefix,
            period: 'rollback',
            limitMinor: 100,
          },
        })
        await audit.record(
          {
            actorId: prefix,
            actorKind: 'human',
            action: 'test.atomic',
            entity: 'Budget',
            entityId: row.id,
          },
          tx,
        )
        if (fail) throw new Error('simulated failure after audit')
        return { id: row.id }
      })
    await expect(action(true)).rejects.toThrow('simulated failure')
    expect(
      await db.budget.count({
        where: { costCenter: prefix, period: 'rollback' },
      }),
    ).toBe(0)
    expect(await db.auditEntry.count({ where: { actorId: prefix } })).toBe(0)
    const result = await action(false)
    expect(await action(false)).toEqual(result)
    expect(await db.auditEntry.count({ where: { actorId: prefix } })).toBe(1)
  })
  it('executes concurrent retries once and rejects changed payload', async () => {
    const target = scope('concurrent')
    let calls = 0
    const run = () =>
      service.runAtomic(target, async () => {
        calls++
        return { ok: true }
      })
    const results = await Promise.all([run(), run(), run()])
    expect(calls).toBe(1)
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    await expect(
      service.runAtomic({ ...target, input: { amount: 2 } }, async () => ({
        ok: true,
      })),
    ).rejects.toThrow('different input')
  })
  it('separates principal and operation namespaces', async () => {
    const target = scope('shared')
    expect(await service.runAtomic(target, async () => 1)).toBe(1)
    expect(
      await service.runAtomic({ ...target, actorId: 'other' }, async () => 2),
    ).toBe(2)
    expect(
      await service.runAtomic({ ...target, operation: 'other' }, async () => 3),
    ).toBe(3)
  })
})
