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

  it('never exposes beneficiary account details through vendor reads', async () => {
    const stored = await db.vendor.create({
      data: {
        name: `Banked Vendor ${suffix}`,
        status: 'active',
        bankAccount: {
          bank: 'Example Bank',
          accountName: 'Banked Vendor',
          accountNumber: '000011112222',
        },
        bankAccountVerifiedAt: new Date(),
        bankAccountVerifiedBy: 'finance-checker',
      },
    })
    vendorIds.push(stored.id)

    const detail = await vendor.detail(stored.id)
    const listed = await vendor.list({ page: 1, pageSize: 100 })
    const row = listed.rows.find((candidate) => candidate.id === stored.id)

    expect(detail).not.toHaveProperty('bankAccount')
    expect(row).toBeDefined()
    expect(row).not.toHaveProperty('bankAccount')
    expect(detail.bankAccountVerifiedAt).toBeInstanceOf(Date)
  })

  it('enrolls and revokes verified contact channels with change invalidation on blacklisting', async () => {
    const v = await vendor.create({
      name: `Contact Vendor ${suffix}`,
      email: `contact-${suffix}@example.com`,
      status: 'active',
    })
    vendorIds.push(v.id)

    const verified = await vendor.verifyContact(
      v.id,
      {
        email: `dispatch-${suffix}@example.com`,
        evidence: 'Supplier onboarding confirmation packet',
      },
      'procurement-officer-1',
    )
    const channels = verified.contactChannels as {
      verifiedEmails: string[]
      entries: Array<{ email: string; evidence: string; verifiedBy: string }>
    }
    expect(channels.verifiedEmails).toContain(`dispatch-${suffix}@example.com`)
    expect(channels.entries[0].evidence).toBe(
      'Supplier onboarding confirmation packet',
    )
    expect(channels.entries[0].verifiedBy).toBe('procurement-officer-1')

    const revoked = await vendor.revokeContact(
      v.id,
      { email: `dispatch-${suffix}@example.com`, reason: 'Rotated address' },
      'procurement-officer-1',
    )
    const revokedChannels = revoked.contactChannels as {
      verifiedEmails: string[]
      entries: unknown[]
    }
    expect(revokedChannels.verifiedEmails).not.toContain(
      `dispatch-${suffix}@example.com`,
    )
    expect(revokedChannels.entries).toHaveLength(0)

    // Re-verify and then blacklist to test change invalidation
    await vendor.verifyContact(
      v.id,
      {
        email: `dispatch2-${suffix}@example.com`,
        evidence: 'Second verification packet',
      },
      'procurement-officer-1',
    )
    const blacklisted = await vendor.update(v.id, {
      status: 'blacklisted',
      blacklistReason: 'Severe fraud detected',
    })
    const blacklistedChannels = blacklisted.contactChannels as {
      verifiedEmails: string[]
    }
    expect(blacklistedChannels.verifiedEmails).toEqual([])
  })
})
