import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { evaluateVendorGate } from '../policy/policy-engine'
import { DocumentNumberService } from '../shared/document-number/document-number.service'
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
  constructor(private readonly numbers: DocumentNumberService) {}

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

  async issue(input: IssueInput, actorId: string): Promise<IssueResult> {
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

    const vendorDecision = evaluateVendorGate(vendor.status)

    const runTransaction = () =>
      db.$transaction(async (tx) => {
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

        return { outcome: 'ISSUED', purchaseOrder } as const
      })

    // §11 sequential PO number is read-then-write; under concurrency two
    // issues may pick the same next number. Retry on that unique-key race —
    // the idempotency layer makes a re-run safe (a dropped claim re-runs).
    for (let attempt = 1; ; attempt++) {
      try {
        return await runTransaction()
      } catch (error) {
        if (attempt < 3 && isSequentialNumberRace(error)) continue
        throw error
      }
    }
  }

  async confirm(id: string): Promise<PurchaseOrderWith> {
    const po = await this.detail(id)
    if (po.status !== 'issued') {
      throw new ConflictException('Only an issued PO can be confirmed')
    }
    return db.purchaseOrder.update({
      where: { id },
      data: { status: 'confirmed' },
      include: { lines: true },
    })
  }

  /** §10.1 — PO cancellation after vendor confirmation needs a human gate. */
  async requestCancellation(id: string, reason: string) {
    const po = await this.detail(id)
    if (po.status !== 'confirmed' && po.status !== 'issued') {
      throw new ConflictException('Only issued/confirmed POs can be cancelled')
    }
    return db.approval.create({
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
