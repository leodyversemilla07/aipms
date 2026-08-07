import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { VendorService } from '../src/vendor/vendor.service'

/**
 * @workspace vendor service — qualification lifecycle against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const vendorIds: string[] = []

afterAll(async () => {
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await db.$disconnect()
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
    vendorIds.push(v.id)

    expect(v.status).toBe('prospective')

    const updated = await vendor.update(v.id, {
      status: 'blacklisted',
      blacklistReason: 'Failed delivery twice',
    })
    expect(updated.status).toBe('blacklisted')
    expect(updated.blacklistReason).toBe('Failed delivery twice')
  })
})
