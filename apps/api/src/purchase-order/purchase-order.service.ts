import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { evaluateVendorGate } from '../policy/policy-engine'
import { DocumentNumberService } from '../shared/document-number/document-number.service'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import { paginate } from '../trpc/list-input'

export type PurchaseOrderWith = Prisma.PurchaseOrderGetPayload<{
  include: { lines: true }
}>

export interface IssueInput {
  requisitionId: string
  vendorId: string
  terms?: Record<string, unknown>
}

export type IssueResult =
  | { outcome: 'ISSUED'; purchaseOrder: PurchaseOrderWith }
  | { outcome: 'NEED_APPROVAL'; vendorId: string; requisitionId: string }

/** True when a Prisma unique-constraint error is a sequential-number race. */
function isSequentialNumberRace(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly numbers: DocumentNumberService,
    private readonly events: EventEmitterService,
  ) {}

  async detail(id: string): Promise<PurchaseOrderWith> {
    const po = await db.purchaseOrder.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!po) throw new NotFoundException(`PurchaseOrder ${id} not found`)
    return po
  }

  async list(input: {
    q?: string
    sort?: string
    dir?: 'asc' | 'desc'
    page: number
    pageSize: number
  }) {
    const { skip, take } = paginate(input)
    const where: Prisma.PurchaseOrderWhereInput = {}
    if (input.q) {
      where.OR = [
        { poNumber: { contains: input.q, mode: 'insensitive' } },
        { vendorId: { contains: input.q, mode: 'insensitive' } },
      ]
    }
    const orderBy: Prisma.PurchaseOrderOrderByWithRelationInput = (
      {
        poNumber: { poNumber: input.dir },
        createdAt: { createdAt: input.dir },
        status: { status: input.dir },
        totalMinor: { totalMinor: input.dir },
      } as Record<string, Prisma.PurchaseOrderOrderByWithRelationInput>
    )[input.sort ?? ''] ?? { createdAt: input.dir }

    const [rows, total] = await Promise.all([
      db.purchaseOrder.findMany({
        where,
        skip,
        take,
        orderBy,
        include: { lines: true },
      }),
      db.purchaseOrder.count({ where }),
    ])
    return { rows, total, facetCounts: {} }
  }

  async issue(
    input: IssueInput,
    actorId: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<IssueResult> {
    const requisition = await db.requisition.findUnique({
      where: { id: input.requisitionId },
      include: { lines: true, approvals: true },
    })
    if (!requisition) {
      throw new NotFoundException('Requisition not found')
    }
    if (requisition.status !== 'approved') {
      throw new ConflictException(
        'Requisition must be approved before a PO is issued',
      )
    }
    const budgetId = requisition.budgetId
    if (!budgetId) {
      throw new ConflictException(
        'Requisition has no budget — cannot commit spend',
      )
    }

    const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } })
    if (!vendor) throw new NotFoundException('Vendor not found')

    const attempt = async (tx: Prisma.TransactionClient) => {
      // Serialize issuance per requisition and revalidate mutable gates after
      // acquiring locks. Different idempotency keys must not double-order.
      await tx.$queryRaw`SELECT id FROM requisition WHERE id = ${input.requisitionId} FOR UPDATE`
      const requisition = await tx.requisition.findUnique({
        where: { id: input.requisitionId },
        include: { lines: true },
      })
      if (requisition?.status !== 'approved') {
        throw new ConflictException(
          'Requisition must be approved before a PO is issued',
        )
      }
      const budgetId = requisition.budgetId
      if (!budgetId) throw new ConflictException('Requisition has no budget')
      const existing = await tx.purchaseOrder.findFirst({
        where: {
          requisitionId: requisition.id,
          status: { not: 'cancelled' },
        },
      })
      if (existing)
        throw new ConflictException('Requisition already has a purchase order')
      await tx.$queryRaw`SELECT id FROM vendor WHERE id = ${input.vendorId} FOR UPDATE`
      const vendor = await tx.vendor.findUnique({
        where: { id: input.vendorId },
      })
      if (!vendor) throw new NotFoundException('Vendor not found')
      const vendorDecision = evaluateVendorGate(vendor.status)
      await tx.$queryRaw`SELECT id FROM budget WHERE id = ${budgetId} FOR UPDATE`
      // Vendor gate: BLACKLIST is a hard block; unqualified needs human approval.
      if (vendorDecision.outcome === 'BLOCK') {
        throw new ConflictException(vendorDecision.reason)
      }
      if (vendorDecision.outcome === 'NEED_APPROVAL') {
        await tx.approval.create({
          data: {
            requisitionId: requisition.id,
            poId: null,
            vendorId: vendor.id,
            kind: 'vendorGate',
            gateOutcome: 'NEED_APPROVAL',
            route: (vendorDecision.approvers ?? []) as string[],
            citations: vendorDecision.citations as string[],
            status: 'pending',
            evidence: vendorDecision.reason,
          },
        })
        return {
          outcome: 'NEED_APPROVAL',
          vendorId: vendor.id,
          requisitionId: requisition.id,
        } as const
      }

      // Budget commit — held in the same transaction, never read-then-write.
      const budget = await tx.budget.findUnique({
        where: { id: budgetId },
      })
      if (!budget) throw new NotFoundException('Budget not found')

      const totalMinor = requisition.lines.reduce(
        (sum, line) => sum + line.lineTotalMinor,
        0,
      )
      if (
        budget.committedMinor + budget.spentMinor + totalMinor >
        budget.limitMinor
      ) {
        throw new ConflictException(
          'Budget overrun — commit would exceed the remaining limit',
        )
      }

      const poNumber = await this.numbers.next('PO-', () =>
        tx.purchaseOrder
          .findFirst({
            orderBy: { poNumber: 'desc' },
            select: { poNumber: true },
          })
          .then((r) => r?.poNumber ?? null),
      )

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          poNumber,
          requisitionId: requisition.id,
          vendorId: vendor.id,
          status: 'issued',
          currencyCode: budget.currencyCode,
          totalMinor,
          terms: input.terms as Prisma.InputJsonValue | undefined,
          issuedBy: actorId,
          issuedAt: new Date(),
          lines: {
            create: requisition.lines.map((line, i) => ({
              lineNo: i + 1,
              sku: line.sku,
              description: line.description,
              quantity: line.quantity,
              unit: line.unit,
              unitPriceMinor: line.unitPriceMinor,
              currencyCode: line.currencyCode,
              lineTotalMinor: line.lineTotalMinor,
            })),
          },
        },
        include: { lines: true },
      })

      await tx.budget.update({
        where: { id: budgetId },
        data: { committedMinor: { increment: totalMinor } },
      })

      await this.events.emit(
        {
          type: 'po.issued',
          entityType: 'PurchaseOrder',
          entityId: purchaseOrder.id,
          payload: { poNumber, vendorId: vendor.id, totalMinor },
        },
        tx,
      )

      return { outcome: 'ISSUED', purchaseOrder } as const
    }

    // §11 sequential PO number is read-then-write; under concurrency two
    // issues may pick the same next number. Retry on that unique-key race.
    // With an outer (idempotent/atomic) transaction a collision aborts the
    // whole transaction, so attempt once and let the caller retry the key.
    if (outerTx) return attempt(outerTx)
    for (let retries = 1; ; retries++) {
      try {
        return await db.$transaction((tx) => attempt(tx))
      } catch (error) {
        if (retries < 3 && isSequentialNumberRace(error)) continue
        throw error
      }
    }
  }

  async confirm(
    id: string,
    tx: Prisma.TransactionClient = db,
  ): Promise<PurchaseOrderWith> {
    const po = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!po) throw new NotFoundException(`PurchaseOrder ${id} not found`)
    if (po.status !== 'issued') {
      throw new ConflictException('Only an issued PO can be confirmed')
    }
    // Conditional update: concurrent transitions must not overwrite each other.
    const updated = await tx.purchaseOrder.updateMany({
      where: { id, status: 'issued' },
      data: { status: 'confirmed' },
    })
    if (updated.count !== 1) {
      throw new ConflictException(
        'Purchase order changed; reload before confirming',
      )
    }
    const confirmed = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: { lines: true },
    })
    await this.events.emit(
      {
        type: 'po.confirmed',
        entityType: 'PurchaseOrder',
        entityId: confirmed.id,
        payload: { status: 'confirmed' },
      },
      tx,
    )
    return confirmed
  }

  /** §10.1 — PO cancellation after vendor confirmation needs a human gate. */
  async requestCancellation(
    id: string,
    reason: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const po = await tx.purchaseOrder.findUnique({ where: { id } })
    if (!po) throw new NotFoundException(`PurchaseOrder ${id} not found`)
    if (po.status !== 'confirmed' && po.status !== 'issued') {
      throw new ConflictException('Only issued/confirmed POs can be cancelled')
    }
    return tx.approval.create({
      data: {
        poId: po.id,
        requisitionId: po.requisitionId,
        kind: 'poCancellation',
        gateOutcome: 'NEED_APPROVAL',
        route: ['finance'],
        citations: ['policy:po-cancellation'],
        status: 'pending',
        evidence: reason,
      },
    })
  }
}
