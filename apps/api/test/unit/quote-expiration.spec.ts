import './no-database'
import { ConflictException } from '@nestjs/common'
import type { Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { PurchaseOrderService } from '../../src/purchase-order/purchase-order.service'
import type { DocumentNumberService } from '../../src/shared/document-number/document-number.service'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'
import { SourcingService } from '../../src/sourcing/sourcing.service'

describe('Quote expiration enforcement (§8.1 / §9)', () => {
  const events = {
    emit: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventEmitterService

  const documentNumbers = {
    next: vi.fn().mockResolvedValue('PO-2026-0001'),
  } as unknown as DocumentNumberService

  describe('SourcingService.compare', () => {
    const sourcing = new SourcingService(events)

    it('marks expired quotes and skips them for recommendedQuoteId under lowestCost', async () => {
      const now = Date.now()
      const requisition = {
        id: 'req-1',
        costCenter: 'eng',
        lines: [{ currencyCode: 'PHP' }],
      }
      const quotes = [
        {
          id: 'q-expired-cheap',
          vendorId: 'v-1',
          currencyCode: 'PHP',
          totalMinor: 50_000,
          validUntil: new Date(now - 3_600_000), // 1 hour ago
        },
        {
          id: 'q-valid-mid',
          vendorId: 'v-2',
          currencyCode: 'PHP',
          totalMinor: 75_000,
          validUntil: new Date(now + 86_400_000), // tomorrow
        },
        {
          id: 'q-valid-open',
          vendorId: 'v-3',
          currencyCode: 'PHP',
          totalMinor: 100_000,
          validUntil: null,
        },
      ]

      const mockTx = {
        requisition: {
          findUnique: vi.fn().mockResolvedValue(requisition),
        },
        quote: {
          findMany: vi.fn().mockResolvedValue(quotes),
        },
        vendor: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        policy: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as unknown as Prisma.TransactionClient

      const result = await sourcing.compare('req-1', mockTx)
      expect(result.recommendedQuoteId).toBe('q-valid-mid')
      expect(result.ranking).toHaveLength(3)
      expect(result.ranking[0]).toMatchObject({
        quoteId: 'q-expired-cheap',
        expired: true,
      })
      expect(result.ranking[1]).toMatchObject({
        quoteId: 'q-valid-mid',
        expired: false,
      })
      expect(result.ranking[2]).toMatchObject({
        quoteId: 'q-valid-open',
        expired: false,
      })
    })

    it('returns null recommendedQuoteId when all received quotes are expired', async () => {
      const now = Date.now()
      const requisition = {
        id: 'req-2',
        costCenter: 'eng',
        lines: [{ currencyCode: 'PHP' }],
      }
      const quotes = [
        {
          id: 'q-expired-1',
          vendorId: 'v-1',
          currencyCode: 'PHP',
          totalMinor: 50_000,
          validUntil: new Date(now - 10_000),
        },
        {
          id: 'q-expired-2',
          vendorId: 'v-2',
          currencyCode: 'PHP',
          totalMinor: 60_000,
          validUntil: new Date(now - 20_000),
        },
      ]

      const mockTx = {
        requisition: {
          findUnique: vi.fn().mockResolvedValue(requisition),
        },
        quote: {
          findMany: vi.fn().mockResolvedValue(quotes),
        },
        vendor: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        policy: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as unknown as Prisma.TransactionClient

      const result = await sourcing.compare('req-2', mockTx)
      expect(result.recommendedQuoteId).toBeNull()
      expect(result.ranking.every((r) => r.expired)).toBe(true)
    })
  })

  describe('SourcingService.award', () => {
    const sourcing = new SourcingService(events)

    it('rejects an expired quote at award with ConflictException', async () => {
      const now = Date.now()
      const expiredQuote = {
        id: 'q-exp',
        requisitionId: 'req-1',
        vendorId: 'v-1',
        status: 'received',
        totalMinor: 50_000,
        currencyCode: 'PHP',
        validUntil: new Date(now - 1_000),
      }

      const mockTx = {
        quote: {
          findUnique: vi.fn().mockResolvedValue(expiredQuote),
        },
      } as unknown as Prisma.TransactionClient

      await expect(sourcing.award('q-exp', 'actor-1', mockTx)).rejects.toThrow(
        ConflictException,
      )
    })

    it('successfully awards an unexpired quote', async () => {
      const now = Date.now()
      const validQuote = {
        id: 'q-valid',
        requisitionId: 'req-1',
        vendorId: 'v-1',
        status: 'received',
        totalMinor: 50_000,
        currencyCode: 'PHP',
        validUntil: new Date(now + 86_400_000),
      }

      const requisition = {
        id: 'req-1',
        costCenter: 'eng',
        lines: [{ currencyCode: 'PHP' }],
      }

      const mockTx = {
        quote: {
          findUnique: vi.fn().mockResolvedValue(validQuote),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...validQuote,
            status: 'accepted',
            awardedAt: new Date(),
          }),
          count: vi.fn().mockResolvedValue(0),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        requisition: {
          findUnique: vi.fn().mockResolvedValue(requisition),
        },
        policy: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      } as unknown as Prisma.TransactionClient

      const awarded = await sourcing.award('q-valid', 'actor-1', mockTx)
      expect(awarded.status).toBe('accepted')
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'quote.awarded',
          entityId: 'q-valid',
        }),
        mockTx,
      )
    })
  })

  describe('PurchaseOrderService.issue', () => {
    const poService = new PurchaseOrderService(documentNumbers, events)

    it('rejects issuing a PO if the accepted quote has commercially expired', async () => {
      const now = Date.now()
      const requisition = {
        id: 'req-po-1',
        status: 'approved',
        budgetId: 'budget-1',
        lines: [{ currencyCode: 'PHP' }],
      }
      const vendor = {
        id: 'v-1',
        status: 'active',
      }
      const expiredAcceptedQuote = {
        id: 'quote-accepted-exp',
        requisitionId: 'req-po-1',
        vendorId: 'v-1',
        status: 'accepted',
        currencyCode: 'PHP',
        totalMinor: 100_000,
        validUntil: new Date(now - 100_000), // expired!
        lines: null,
      }

      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        requisition: {
          findUnique: vi.fn().mockResolvedValue(requisition),
        },
        vendor: {
          findUnique: vi.fn().mockResolvedValue(vendor),
        },
        purchaseOrder: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        quote: {
          findMany: vi.fn().mockResolvedValue([expiredAcceptedQuote]),
        },
      } as unknown as Prisma.TransactionClient

      await expect(
        poService.issue(
          { requisitionId: 'req-po-1', vendorId: 'v-1' },
          'buyer-1',
          mockTx,
        ),
      ).rejects.toThrow(
        /Accepted quote has expired — re-quote required before PO issue/,
      )
    })

    it('issues PO successfully when accepted quote is unexpired', async () => {
      const now = Date.now()
      const requisition = {
        id: 'req-po-2',
        status: 'approved',
        budgetId: 'budget-1',
        lines: [
          {
            lineNo: 1,
            sku: 'SKU-1',
            description: 'Item 1',
            quantity: 1,
            unit: 'ea',
            unitPriceMinor: 100_000,
            currencyCode: 'PHP',
            lineTotalMinor: 100_000,
          },
        ],
      }
      const vendor = {
        id: 'v-2',
        status: 'active',
      }
      const validAcceptedQuote = {
        id: 'quote-accepted-valid',
        requisitionId: 'req-po-2',
        vendorId: 'v-2',
        status: 'accepted',
        currencyCode: 'PHP',
        totalMinor: 100_000,
        validUntil: new Date(now + 86_400_000), // valid!
        lines: null,
      }
      const budget = {
        id: 'budget-1',
        currencyCode: 'PHP',
        committedMinor: 0,
        spentMinor: 0,
        limitMinor: 1_000_000,
      }

      const mockTx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: vi.fn().mockResolvedValue(1),
        requisition: {
          findUnique: vi.fn().mockResolvedValue(requisition),
        },
        vendor: {
          findUnique: vi.fn().mockResolvedValue(vendor),
        },
        purchaseOrder: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: 'po-1',
            poNumber: 'PO-2026-0001',
            status: 'issued',
            totalMinor: 100_000,
            lines: [],
          }),
        },
        quote: {
          findMany: vi.fn().mockResolvedValue([validAcceptedQuote]),
        },
        budget: {
          findUnique: vi.fn().mockResolvedValue(budget),
          update: vi.fn().mockResolvedValue(budget),
        },
      } as unknown as Prisma.TransactionClient

      const result = await poService.issue(
        { requisitionId: 'req-po-2', vendorId: 'v-2' },
        'buyer-1',
        mockTx,
      )

      expect(result.outcome).toBe('ISSUED')
      if (result.outcome === 'ISSUED') {
        expect(result.purchaseOrder.poNumber).toBe('PO-2026-0001')
      }
    })
  })
})
