import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { PolicyService } from '../policy/policy.service'
import {
  evaluateThresholdGate,
  type GateDecision,
} from '../policy/policy-engine'
import { DocumentNumberService } from '../shared/document-number/document-number.service'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import { paginate } from '../trpc/list-input'

export interface CreateRequisitionLineInput {
  sku?: string | null
  description: string
  quantity: number
  unit?: string
  unitPriceMinor: number
  currencyCode?: string
}

export interface CreateRequisition {
  requestedBy: string
  costCenter: string
  budgetId?: string | null
  priority?: string
  note?: string | null
  lines: CreateRequisitionLineInput[]
}

export type RequisitionWith = Prisma.RequisitionGetPayload<{
  include: { lines: true; approvals: true }
}>

export interface SubmitResult {
  requisition: RequisitionWith
  decision: GateDecision
}

export interface RequisitionListInput {
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  page: number
  pageSize: number
}

@Injectable()
export class RequisitionService {
  constructor(
    private readonly numbers: DocumentNumberService,
    private readonly policy: PolicyService,
    private readonly events: EventEmitterService,
  ) {}

  async list(input: RequisitionListInput) {
    const { skip, take } = paginate(input)
    const where: Prisma.RequisitionWhereInput = {}
    if (input.q) {
      where.OR = [
        { requestNumber: { contains: input.q, mode: 'insensitive' } },
        { costCenter: { contains: input.q, mode: 'insensitive' } },
        { requestedBy: { contains: input.q, mode: 'insensitive' } },
      ]
    }

    const orderBy: Prisma.RequisitionOrderByWithRelationInput = (
      {
        requestNumber: { requestNumber: input.dir },
        createdAt: { createdAt: input.dir },
        status: { status: input.dir },
        costCenter: { costCenter: input.dir },
      } as Record<string, Prisma.RequisitionOrderByWithRelationInput>
    )[input.sort ?? ''] ?? { createdAt: input.dir }

    const [rows, total] = await Promise.all([
      db.requisition.findMany({
        where,
        skip,
        take,
        orderBy,
        include: { lines: true, approvals: true },
      }),
      db.requisition.count({ where }),
    ])
    return { rows, total, facetCounts: {} }
  }

  async detail(id: string): Promise<RequisitionWith> {
    const req = await db.requisition.findUnique({
      where: { id },
      include: { lines: true, approvals: true },
    })
    if (!req) throw new NotFoundException(`Requisition ${id} not found`)
    return req
  }

  async create(input: CreateRequisition): Promise<RequisitionWith> {
    if (!input.lines.length) {
      throw new BadRequestException('Requisition needs at least one line')
    }

    const lines = input.lines.map((line, i) => ({
      lineNo: i + 1,
      sku: line.sku ?? null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit ?? 'ea',
      unitPriceMinor: line.unitPriceMinor,
      currencyCode: line.currencyCode ?? 'PHP',
      lineTotalMinor: line.quantity * line.unitPriceMinor,
    }))

    for (let attempt = 0; attempt < 3; attempt++) {
      const requestNumber = await this.numbers.next('REQ-', () =>
        db.requisition
          .findFirst({
            orderBy: { requestNumber: 'desc' },
            select: { requestNumber: true },
          })
          .then((r) => r?.requestNumber ?? null),
      )

      try {
        return await db.requisition.create({
          data: {
            requestNumber,
            requestedBy: input.requestedBy,
            costCenter: input.costCenter,
            budgetId: input.budgetId ?? null,
            priority: input.priority ?? 'normal',
            note: input.note ?? null,
            status: 'draft',
            lines: { create: lines },
          },
          include: { lines: true, approvals: true },
        })
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue
        }
        throw error
      }
    }
    throw new ConflictException('Could not allocate a request number')
  }

  /** The exception queue (§10.2): blocked requisitions and open gates. */
  async exceptionQueue() {
    const requisitions = await db.requisition.findMany({
      where: { status: 'exception' },
      include: { lines: true, approvals: true },
      orderBy: { createdAt: 'asc' },
    })
    const pendingApprovals = await db.approval.findMany({
      where: { status: 'pending', requisitionId: { not: null } },
      include: { requisition: { include: { lines: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return { requisitions, pendingApprovals }
  }

  /**
   * Submit: evaluate the §11 gate inside the same transaction and record it.
   * PASS → auto-approves; NEED_APPROVAL → `submitted` + pending gate;
   * BLOCK → `exception` + pending gate (surfaced in the exception queue).
   */
  async submit(id: string): Promise<SubmitResult> {
    const requisition = await this.detail(id)
    if (requisition.status !== 'draft') {
      throw new ConflictException('Only draft requisitions can be submitted')
    }

    const totalMinor = requisition.lines.reduce(
      (sum, line) => sum + line.lineTotalMinor,
      0,
    )

    const thresholdPolicy = await this.policy.latest('threshold')
    let budgetRemainingMinor: number | undefined
    if (requisition.budgetId) {
      const budget = await db.budget.findUnique({
        where: { id: requisition.budgetId },
      })
      if (!budget) throw new NotFoundException('Budget not found')
      budgetRemainingMinor =
        budget.limitMinor - budget.committedMinor - budget.spentMinor
    }

    const decision = evaluateThresholdGate(thresholdPolicy ?? undefined, {
      costCenter: requisition.costCenter,
      amountMinor: totalMinor,
      budgetAssigned: Boolean(requisition.budgetId),
      budgetRemainingMinor,
    })

    return db.$transaction(async (tx) => {
      const now = new Date()

      if (decision.outcome === 'PASS') {
        const req = await tx.requisition.update({
          where: { id },
          data: { status: 'approved', submittedAt: now, decidedAt: now },
          include: { lines: true, approvals: true },
        })
        await tx.approval.create({
          data: {
            requisitionId: id,
            kind: 'threshold',
            gateOutcome: 'PASS',
            route: [],
            citations: decision.citations,
            status: 'approved',
            decidedBy: 'system',
            decidedAt: now,
            evidence: decision.reason,
          },
        })
        await this.events.emit(
          {
            type: 'requisition.approved',
            entityType: 'Requisition',
            entityId: id,
            payload: { status: 'approved', requestNumber: req.requestNumber, costCenter: req.costCenter, totalMinor },
          },
          tx,
        )
        return { requisition: req, decision }
      }

      const nextStatus =
        decision.outcome === 'BLOCK' ? 'exception' : 'submitted'
      const req = await tx.requisition.update({
        where: { id },
        data: { status: nextStatus, submittedAt: now },
        include: { lines: true, approvals: true },
      })
      await tx.approval.create({
        data: {
          requisitionId: id,
          kind: decision.gateKind,
          gateOutcome: decision.outcome,
          route: (decision.approvers ?? []) as string[],
          citations: decision.citations as string[],
          status: 'pending',
          evidence: decision.reason,
        },
      })
      await this.events.emit(
        {
          type: 'requisition.submitted',
          entityType: 'Requisition',
          entityId: id,
          payload: { status: nextStatus, requestNumber: req.requestNumber, costCenter: req.costCenter, totalMinor },
        },
        tx,
      )
      return { requisition: req, decision }
    })
  }
}
