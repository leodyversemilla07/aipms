import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type Prisma } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'

export type DecideVerdict = 'approve' | 'reject' | 'override'

export interface DecideResult {
  approval: Prisma.ApprovalGetPayload<object>
  outcome: 'APPROVED' | 'REJECTED' | 'OVERRIDDEN' | 'PO_CANCELLED' | 'KEPT'
  requisitionStatus?: string
  poStatus?: string
}

/**
 * §10 gate resolution. Each pending Approval is a ticket in the exception
 * queue; a human decides it. Approving a gate lets the workflow proceed;
 * rejecting closes it; overriding (with a reason, never silent) records the
 * exception. Cancelling a PO releases its committed budget — the compensating
 * action for the issue-time commit (§13 saga shape).
 */
@Injectable()
export class ApprovalService {
  constructor(private readonly events: EventEmitterService) {}
  async pendingList() {
    return db.approval.findMany({
      where: { status: 'pending' },
      include: {
        requisition: { include: { lines: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async detail(id: string) {
    const approval = await db.approval.findUnique({
      where: { id },
      include: { requisition: { include: { lines: true } } },
    })
    if (!approval) throw new NotFoundException(`Approval ${id} not found`)
    return approval
  }

  async decide(
    id: string,
    verdict: DecideVerdict,
    actorId: string,
    evidence?: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<DecideResult> {
    const run = async (tx: Prisma.TransactionClient): Promise<DecideResult> => {
      const approval = await tx.approval.findUnique({ where: { id } })
      if (!approval) throw new NotFoundException(`Approval ${id} not found`)
      if (approval.status !== 'pending') {
        throw new ConflictException('Approval already decided')
      }

      // §10 authorization: the deciding actor must be a human whose role is on
      // the approval's route (or an admin). Unknown principals (e.g. the
      // service-token agent) can never decide human gates.
      const actor = await tx.user.findUnique({
        where: { id: actorId },
        select: { role: true },
      })
      if (!actor) {
        throw new ForbiddenException(
          `Principal ${actorId} is not authorized to decide approvals`,
        )
      }
      const route = (approval.route ?? []) as string[]
      if (actor.role !== 'admin' && !route.includes(actor.role)) {
        throw new ForbiddenException(
          `Role ${actor.role} is not on this approval's route (${route.join(', ') || 'admin only'})`,
        )
      }

      const now = new Date()
      const decidedStatus =
        verdict === 'reject'
          ? 'rejected'
          : verdict === 'override'
            ? 'overridden'
            : 'approved'
      const updated = await tx.approval.update({
        where: { id },
        data: {
          status: decidedStatus,
          decidedBy: actorId,
          decidedAt: now,
          evidence: evidence ?? null,
        },
      })
      await this.events.emit(
        {
          type: 'approval.decided',
          entityType: 'Approval',
          entityId: id,
          payload: { verdict, outcome: decidedStatus, kind: approval.kind },
        },
        tx,
      )

      // --- PO cancellation gate (§10.1) --------------------------------
      if (approval.kind === 'poCancellation' && approval.poId) {
        if (verdict === 'reject') {
          return { approval: updated, outcome: 'KEPT' }
        }
        const po = await tx.purchaseOrder.update({
          where: { id: approval.poId },
          data: { status: 'cancelled' },
          include: { lines: true },
        })
        await this.releaseCommittedBudget(
          tx,
          approval.requisitionId,
          po.totalMinor,
        )
        await this.events.emit(
          {
            type: 'po.cancelled',
            entityType: 'PurchaseOrder',
            entityId: approval.poId,
            payload: { status: 'cancelled' },
          },
          tx,
        )
        return {
          approval: updated,
          outcome: 'PO_CANCELLED',
          poStatus: po.status,
        }
      }

      // --- Vendor qualification gate (§10.1) ---------------------------
      if (approval.kind === 'vendorGate' && approval.vendorId) {
        if (verdict === 'reject') {
          return { approval: updated, outcome: 'REJECTED' }
        }
        await tx.vendor.update({
          where: { id: approval.vendorId },
          data: { status: 'active' },
        })
        return {
          approval: updated,
          outcome: verdict === 'override' ? 'OVERRIDDEN' : 'APPROVED',
        }
      }

      // --- Requisition gates (threshold / budgetOverride / policyGate) -
      if (approval.requisitionId) {
        if (verdict === 'reject') {
          const req = await tx.requisition.update({
            where: { id: approval.requisitionId },
            data: { status: 'rejected', decidedAt: now },
          })
          await this.events.emit(
            {
              type: 'requisition.rejected',
              entityType: 'Requisition',
              entityId: approval.requisitionId,
              payload: { status: 'rejected' },
            },
            tx,
          )
          return {
            approval: updated,
            outcome: 'REJECTED',
            requisitionStatus: req.status,
          }
        }

        const remainingPending = await tx.approval.count({
          where: { requisitionId: approval.requisitionId, status: 'pending' },
        })
        const nextStatus = remainingPending === 0 ? 'approved' : 'submitted'
        const req = await tx.requisition.update({
          where: { id: approval.requisitionId },
          data: { status: nextStatus, decidedAt: now },
        })
        if (nextStatus === 'approved') {
          await this.events.emit(
            {
              type: 'requisition.approved',
              entityType: 'Requisition',
              entityId: approval.requisitionId,
              payload: { status: 'approved' },
            },
            tx,
          )
        }
        return {
          approval: updated,
          outcome: verdict === 'override' ? 'OVERRIDDEN' : 'APPROVED',
          requisitionStatus: req.status,
        }
      }

      return { approval: updated, outcome: 'KEPT' }
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /** Release the committed amount when a PO is cancelled (floor at 0). */
  private async releaseCommittedBudget(
    tx: Prisma.TransactionClient,
    requisitionId: string | null,
    amountMinor: number,
  ) {
    if (!requisitionId) return
    const req = await tx.requisition.findUnique({
      where: { id: requisitionId },
      select: { budgetId: true },
    })
    if (!req?.budgetId) return
    const budget = await tx.budget.findUnique({ where: { id: req.budgetId } })
    if (!budget) return
    await tx.budget.update({
      where: { id: req.budgetId },
      data: {
        committedMinor: Math.max(0, budget.committedMinor - amountMinor),
      },
    })
  }
}
