import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { CatalogService } from '../src/catalog/catalog.service'

/**
 * @workspace/catalog service — CRUD against local Postgres (docker-compose).
 */

const suffix = Math.random().toString(36).slice(2, 8)
const catalogIds: string[] = []

afterAll(async () => {
  await db.catalogItem.deleteMany({ where: { id: { in: catalogIds } } })
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
    catalogIds.push(item.id)

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
