import { randomUUID } from 'node:crypto'
import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { InvoiceService } from '../src/invoice/invoice.service'

const vendorId = `page-test-${randomUUID()}`

afterAll(async () => {
  await db.invoice.deleteMany({ where: { vendorId } })
  await db.$disconnect()
})

describe('invoice server pages', () => {
  it('returns a count and stable, non-overlapping pages', async () => {
    await db.invoice.createMany({
      data: Array.from({ length: 27 }, (_, index) => ({
        vendorId,
        number: `page-${index}`,
        amountMinor: 1000,
        status: 'received',
        receivedAt: new Date('2999-01-01T00:00:00Z'),
      })),
    })
    const service = new InvoiceService({} as never, {} as never)
    const first = await service.page({ page: 1, pageSize: 25 })
    const second = await service.page({ page: 2, pageSize: 25 })

    expect(first.total).toBeGreaterThanOrEqual(27)
    expect(first.rows).toHaveLength(25)
    expect(first.rows.every((row) => row.vendorId === vendorId)).toBe(true)
    expect(
      second.rows.slice(0, 2).every((row) => row.vendorId === vendorId),
    ).toBe(true)
    expect(first.rows[24]?.id).not.toBe(second.rows[0]?.id)
    expect(first.rows[0]?.id.localeCompare(first.rows[1]?.id ?? '')).toBe(1)
  })
})
