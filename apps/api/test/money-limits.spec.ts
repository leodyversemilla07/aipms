import { PH_DEFAULT_POLICY } from '@workspace/tax'
import { describe, expect, it } from 'vitest'
import { invoicePayloadSchema } from '../src/agent/invoice-payload'
import { InvoiceService } from '../src/invoice/invoice.service'
import { RequisitionService } from '../src/requisition/requisition.service'
import {
  DATABASE_INT_MAX,
  nonnegativeMinorUnits,
  positiveDatabaseInt,
} from '../src/shared/money/minor-units'

describe('signed 32-bit database limits', () => {
  it('accepts the boundary and rejects larger money and quantity inputs', () => {
    expect(nonnegativeMinorUnits.parse(DATABASE_INT_MAX)).toBe(DATABASE_INT_MAX)
    expect(positiveDatabaseInt.parse(DATABASE_INT_MAX)).toBe(DATABASE_INT_MAX)
    expect(() => nonnegativeMinorUnits.parse(DATABASE_INT_MAX + 1)).toThrow()
    expect(() => positiveDatabaseInt.parse(DATABASE_INT_MAX + 1)).toThrow()
  })

  it('rejects oversized structured invoice payloads before agent processing', () => {
    expect(() =>
      invoicePayloadSchema.parse({
        vendorId: 'vendor',
        number: 'INV-OVERFLOW',
        lines: [
          {
            amountMinor: DATABASE_INT_MAX + 1,
            class: 'goods',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects derived requisition line and aggregate overflows before writing', async () => {
    const service = new RequisitionService(
      {} as never,
      {} as never,
      {} as never,
    )
    const base = {
      requestedBy: 'requester',
      costCenter: 'CC',
    }

    await expect(
      service.create({
        ...base,
        lines: [
          {
            description: 'overflowing multiplication',
            quantity: 2,
            unitPriceMinor: DATABASE_INT_MAX,
          },
        ],
      }),
    ).rejects.toThrow(/Line 1 total exceeds/)

    await expect(
      service.create({
        ...base,
        lines: [
          {
            description: 'first',
            quantity: 1,
            unitPriceMinor: DATABASE_INT_MAX,
          },
          { description: 'second', quantity: 1, unitPriceMinor: 1 },
        ],
      }),
    ).rejects.toThrow(/Requisition total exceeds/)
  })

  it('rejects invoice totals whose derived fields cannot be persisted', async () => {
    const service = new InvoiceService(
      { taxConfig: async () => PH_DEFAULT_POLICY } as never,
      {} as never,
    )
    await expect(
      service.compute({
        lines: [
          { amountMinor: DATABASE_INT_MAX, class: 'goods' },
          { amountMinor: 1, class: 'goods' },
        ],
      }),
    ).rejects.toThrow(/Invoice gross exceeds/)
  })
})
