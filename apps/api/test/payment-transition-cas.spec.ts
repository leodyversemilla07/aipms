import { ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'

vi.mock('@workspace/db', () => ({
  db: {
    paymentRun: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
}))

afterEach(() => vi.restoreAllMocks())

describe('payment transition compare-and-set', () => {
  it('refuses an approval when another transition won', async () => {
    const service = new PaymentRunService(new DocumentNumberService())
    vi.mocked(db.paymentRun.findUnique).mockResolvedValue({
      status: 'draft',
      createdBy: 'maker',
    } as Awaited<ReturnType<typeof db.paymentRun.findUnique>>)
    vi.mocked(db.paymentRun.updateMany).mockResolvedValue({ count: 0 })
    await expect(service.approve('run', 'checker')).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(db.paymentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run', status: 'draft', createdBy: { not: 'checker' } },
      }),
    )
  })

  it('refuses duplicate execution after a stale approved read', async () => {
    const service = new PaymentRunService(new DocumentNumberService())
    vi.mocked(db.paymentRun.findUnique).mockResolvedValue({
      status: 'approved',
    } as Awaited<ReturnType<typeof db.paymentRun.findUnique>>)
    vi.mocked(db.paymentRun.updateMany).mockResolvedValue({ count: 0 })
    await expect(service.execute('run', 'checker')).rejects.toBeInstanceOf(
      ConflictException,
    )
    expect(db.paymentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run', status: 'approved' },
      }),
    )
  })
})
