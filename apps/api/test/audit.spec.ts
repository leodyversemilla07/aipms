import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'

/**
 * @workspace audit service — append-only trail + content hash (§9).
 */

const suffix = Math.random().toString(36).slice(2, 8)
const auditIds: string[] = []

afterAll(async () => {
  await db.auditEntry.deleteMany({ where: { id: { in: auditIds } } })
  await db.$disconnect()
})

describe('AuditService (§9 append-only)', () => {
  const audit = new AuditService()

  it('records an entry with a stable content hash', async () => {
    const input = { sku: `PH-TEST-${suffix}`, name: 'Cable' }
    await audit.record({
      actorId: 'user-1',
      actorKind: 'human',
      action: 'catalog.create',
      entity: 'CatalogItem',
      entityId: 'catalog-1',
      input,
      after: { ...input, active: true },
    })

    const entries = await db.auditEntry.findMany({
      where: { entity: 'CatalogItem', entityId: 'catalog-1' },
    })
    auditIds.push(...entries.map((e) => e.id))

    expect(entries.length).toBe(1)
    expect(entries[0]?.action).toBe('catalog.create')
    expect(entries[0]?.inputHash).toBe(audit.hash(input))
  })
})
