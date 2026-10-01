import './no-database'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { assertLiveInvoicePurchaseOrders } from '../../src/payment-run/payment-eligibility'

function fixture(orders: { id: string; status: string }[]) {
  const findMany = vi.fn().mockResolvedValue(orders)
  const tx = {
    purchaseOrder: { findMany },
  } as unknown as Prisma.TransactionClient
  return { tx, findMany }
}

describe('payment planning rechecks linked PO lifecycle', () => {
  it('accepts issued/confirmed references and deduplicates the lookup', async () => {
    const { tx, findMany } = fixture([
      { id: 'po-1', status: 'issued' },
      { id: 'po-2', status: 'confirmed' },
    ])
    await expect(
      assertLiveInvoicePurchaseOrders(
        [
          { number: 'INV-1', poId: 'po-1' },
          { number: 'INV-2', poId: 'po-2' },
          { number: 'INV-3', poId: 'po-1' },
        ],
        tx,
      ),
    ).resolves.toBeUndefined()
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['po-1', 'po-2'] } },
      select: { id: true, status: true },
    })
  })

  it.each(['draft', 'cancelled'])(
    'refuses a legacy matched invoice referencing a %s PO',
    async (status) => {
      const { tx } = fixture([{ id: 'po-1', status }])
      await expect(
        assertLiveInvoicePurchaseOrders(
          [{ number: 'INV-1', poId: 'po-1' }],
          tx,
        ),
      ).rejects.toThrow(/INV-1.*non-live PO/)
    },
  )

  it('refuses a dangling PO reference', async () => {
    const { tx } = fixture([])
    await expect(
      assertLiveInvoicePurchaseOrders(
        [{ number: 'INV-1', poId: 'missing-po' }],
        tx,
      ),
    ).rejects.toThrow(/missing or non-live PO/)
  })

  it('preserves explicitly standalone matched invoices without inventing PO references', async () => {
    const { tx, findMany } = fixture([])
    await expect(
      assertLiveInvoicePurchaseOrders([{ number: 'INV-1', poId: null }], tx),
    ).resolves.toBeUndefined()
    expect(findMany).not.toHaveBeenCalled()
  })
})
