import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { BudgetService } from './budget/budget.service'
import { CatalogService } from './catalog/catalog.service'
import { PolicyService } from './policy/policy.service'
import { AuditService } from './shared/audit/audit.service'
import { IdempotencyService } from './shared/idempotency/idempotency.service'
import { VendorService } from './vendor/vendor.service'

/**
 * Phase 1 domain-core integration tests against the local Postgres
 * (docker-compose). Services are constructor-less @Injectable classes, so they
 * are exercised directly; the routers/zod/DI wiring is covered by the e2e
 * module test.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const createdIds: Record<string, string[]> = {
  catalog: [],
  vendor: [],
  budget: [],
  policy: [],
  audit: [],
  idempotency: [],
}

afterAll(async () => {
  await db.auditEntry.deleteMany({ where: { id: { in: createdIds.audit } } })
  await db.idempotencyKey.deleteMany({
    where: { id: { in: createdIds.idempotency } },
  })
  await db.policy.deleteMany({ where: { id: { in: createdIds.policy } } })
  await db.budget.deleteMany({ where: { id: { in: createdIds.budget } } })
  await db.vendor.deleteMany({ where: { id: { in: createdIds.vendor } } })
  await db.catalogItem.deleteMany({ where: { id: { in: createdIds.catalog } } })
  await db.$disconnect()
})

describe('CatalogService', () => {
  const catalog = new CatalogService()

  it('creates, lists, updates, and deactivates an item', async () => {
    const item = await catalog.create({
      sku: `PH-TEST-${suffix}`,
      name: 'Steel cable 12mm',
      category: 'materials',
      unit: 'm',
      defaultPriceMinor: 125_00, // ₱125.00
    })
    createdIds.catalog.push(item.id)

    expect(item.active).toBe(true)
    expect(item.defaultCurrencyCode).toBe('PHP')

    const listed = await catalog.list({
      q: 'Steel cable',
      sort: 'name',
      dir: 'asc',
      page: 1,
      pageSize: 25,
    })
    expect(listed.total).toBeGreaterThanOrEqual(1)
    expect(listed.rows[0]?.name).toMatch(/Steel cable/)

    const updated = await catalog.update(item.id, {
      defaultPriceMinor: 130_00,
      active: false,
    })
    expect(updated.defaultPriceMinor).toBe(130_00)
    expect(updated.active).toBe(false)

    const deactivated = await catalog.deactivate(item.id)
    expect(deactivated.active).toBe(false)

    await expect(catalog.detail('missing-id')).rejects.toThrow('not found')
  })
})

describe('VendorService', () => {
  const vendor = new VendorService()

  it('creates with a default status and updates qualification', async () => {
    const v = await vendor.create({
      name: `Acme PH ${suffix}`,
      email: `acme-${suffix}@example.com`,
      taxId: '123-456-789',
      paymentTermsDays: 30,
    })
    createdIds.vendor.push(v.id)

    expect(v.status).toBe('prospective')

    const updated = await vendor.update(v.id, {
      status: 'blacklisted',
      blacklistReason: 'Failed delivery twice',
    })
    expect(updated.status).toBe('blacklisted')
    expect(updated.blacklistReason).toBe('Failed delivery twice')
  })
})

describe('BudgetService', () => {
  const budget = new BudgetService()

  it('creates a budget and computes remaining', async () => {
    const b = await budget.create({
      name: `Q1 Materials ${suffix}`,
      costCenter: 'CC-100',
      period: '2026-01',
      limitMinor: 1_000_000_00, // ₱1,000,000.00
    })
    createdIds.budget.push(b.id)

    const remaining = await budget.remaining(b.id)
    expect(remaining.remainingMinor).toBe(1_000_000_00)
    expect(remaining.budget.committedMinor).toBe(0)
  })
})

describe('PolicyService (versioning + evaluation seam)', () => {
  const policy = new PolicyService()

  it('versions policies and resolves the latest enabled per kind', async () => {
    const v1 = await policy.create({
      name: 'Sourcing threshold (trial)',
      kind: 'threshold',
      config: { currency: 'PHP', autoApproveUpToMinor: 50_000_00 },
      updatedBy: 'test-user',
    })
    createdIds.policy.push(v1.id)
    expect(v1.version).toBe(1)

    const v2 = await policy.create({
      name: 'Sourcing threshold (revised)',
      kind: 'threshold',
      supersedesId: v1.id,
      config: { currency: 'PHP', autoApproveUpToMinor: 100_000_00 },
      updatedBy: 'test-user',
    })
    createdIds.policy.push(v2.id)
    expect(v2.version).toBe(2)
    expect(v2.supersedesId).toBe(v1.id)

    const evalPolicy = await policy.create({
      name: 'MEARB evaluation',
      kind: 'evaluationCriterion',
      config: {
        criterion: 'mearb',
        priceWeightPct: 30,
        technicalWeightPct: 70,
      },
      updatedBy: 'test-user',
    })
    createdIds.policy.push(evalPolicy.id)

    const active = await policy.activeByKind()
    // Parallel specs may supersede this chain further; the guarantee that
    // matters is that the revised policy (not v1) resolved as active.
    expect(active.threshold?.version ?? 0).toBeGreaterThanOrEqual(2)
    expect(active.evaluationCriterion?.config).toMatchObject({
      criterion: 'mearb',
      priceWeightPct: 30,
    })
  })
})

describe('IdempotencyService (§9)', () => {
  const idempotency = new IdempotencyService()

  it('returns the stored outcome on key replay instead of re-running', async () => {
    let executions = 0
    const run = (key: string) =>
      idempotency.run(key, async () => {
        executions += 1
        return { value: executions }
      })

    const first = await run(`catalog.create:${suffix}`)
    const replay = await run(`catalog.create:${suffix}`)

    expect(first).toEqual({ value: 1 })
    expect(replay).toEqual({ value: 1 })
    expect(executions).toBe(1)

    const keys = await db.idempotencyKey.findMany({
      where: { key: `catalog.create:${suffix}` },
    })
    createdIds.idempotency.push(...keys.map((k) => k.id))
  })
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
    createdIds.audit.push(...entries.map((e) => e.id))

    expect(entries.length).toBe(1)
    expect(entries[0]?.action).toBe('catalog.create')
    expect(entries[0]?.inputHash).toBe(audit.hash(input))
  })
})
