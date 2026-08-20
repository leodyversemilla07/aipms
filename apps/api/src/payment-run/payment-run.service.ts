import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  db,
  Prisma,
  type PaymentRunStatus,
  type PaymentStatus,
} from '@workspace/db'
import { DocumentNumberService } from '../shared/document-number/document-number.service'

/**
 * §8.6 approved payment run (hand-off to finance, not bank-file execution).
 *
 * - Net per line is deterministic: invoice gross + VAT − EWT (the tax engine's
 *   net payable). The agent composes and rationalizes; it never derives money.
 * - A run will not plan an invoice whose vendor has no **verified** bank
 *   account (§8.6 beneficiary control) — the whole run is refused with the
 *   unverified suppliers listed, so the planner is explicit.
 * - Approval is maker/checker: the approver must differ from the creator.
 * - Reconciliation (paid/dishonored/rejected) happens after finance executes
 *   the hand-off; when every line is reconciled the run closes.
 */

export interface CreateRunInput {
  invoiceIds: string[]
  notes?: unknown
}

@Injectable()
export class PaymentRunService {
  constructor(private readonly documentNumber: DocumentNumberService) {}

  /** §9 deterministic net payable = gross + VAT − EWT. */
  netPayable(invoice: {
    amountMinor: number
    vatMinor: number
    ewtMinor: number
  }): number {
    return invoice.amountMinor + invoice.vatMinor - invoice.ewtMinor
  }

  async create(input: CreateRunInput, createdBy: string) {
    if (input.invoiceIds.length === 0) {
      throw new BadRequestException('A run needs at least one invoice')
    }
    const uniqueIds = [...new Set(input.invoiceIds)]
    const invoices = await db.invoice.findMany({
      where: { id: { in: uniqueIds } },
    })
    if (invoices.length !== uniqueIds.length) {
      throw new NotFoundException('One or more invoices do not exist')
    }

    // §8.6 beneficiary control: no run plans an invoice without a verified bank.
    const vendorIds = [...new Set(invoices.map((invoice) => invoice.vendorId))]
    const vendors = await db.vendor.findMany({
      where: { id: { in: vendorIds } },
    })
    const unverified = vendors.filter(
      (vendor) =>
        vendor.bankAccount == null ||
        vendor.bankAccountVerifiedAt == null ||
        vendor.bankAccountChangedAt != null,
    )
    if (unverified.length > 0) {
      throw new BadRequestException(
        `Unverified beneficiary accounts for: ${unverified.map((vendor) => vendor.name).join(', ')}`,
      )
    }

    const netByInvoice = new Map(
      invoices.map((invoice) => [invoice.id, this.netPayable(invoice)]),
    )
    const totalMinor = invoices.reduce(
      (sum, invoice) => sum + (netByInvoice.get(invoice.id) ?? 0),
      0,
    )

    // §8.6 race-hardened create: invoice eligibility is re-checked inside the
    // transaction under FOR UPDATE row locks (serializes concurrent creates
    // claiming the same invoices), and the run number is minted in the same
    // transaction — a runNumber collision retries with a fresh number.
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>(
            Prisma.sql`SELECT id FROM "invoice" WHERE id IN (${Prisma.join(uniqueIds)}) FOR UPDATE`,
          )
          if (locked.length !== uniqueIds.length) {
            throw new NotFoundException('One or more invoices do not exist')
          }

          // Only matched invoices are payable; anything already claimed by
          // another run (unique line) or already paid is refused.
          const fresh = await tx.invoice.findMany({
            where: { id: { in: uniqueIds } },
            select: { id: true, status: true, number: true },
          })
          for (const invoice of fresh) {
            if (invoice.status !== 'matched') {
              throw new BadRequestException(
                `Invoice ${invoice.number} is ${invoice.status}, not payable`,
              )
            }
          }
          const claimed = await tx.paymentRunLine.findMany({
            where: { invoiceId: { in: uniqueIds } },
            select: { invoiceId: true },
          })
          if (claimed.length > 0) {
            throw new ConflictException(
              'One or more invoices are already in a payment run',
            )
          }

          // Serialize the run-number mint with a transaction advisory lock so
          // parallel creates on disjoint invoices cannot collide; the retry
          // loop below is a belt-and-braces net for any residual race.
          const runNumber = await this.documentNumber.next('RUN-', async () => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payment_run_number'))`
            const last = await tx.paymentRun.findFirst({
              orderBy: { runNumber: 'desc' },
            })
            return last?.runNumber ?? null
          })

          const run = await tx.paymentRun.create({
            data: {
              runNumber,
              status: 'draft',
              totalMinor,
              currencyCode: 'PHP',
              notes: input.notes ?? undefined,
              createdBy,
              lines: {
                create: invoices.map((invoice) => ({
                  invoiceId: invoice.id,
                  netMinor: netByInvoice.get(invoice.id) ?? 0,
                  status: 'planned',
                })),
              },
            },
            include: { lines: true },
          })
          return { run, netMinor: totalMinor }
        })
      } catch (error) {
        const target = (error as { meta?: { target?: unknown } }).meta?.target
        const isRunNumberCollision =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          Array.isArray(target) &&
          target.includes('runNumber')
        if (isRunNumberCollision && attempt < 3) continue
        throw error
      }
    }
  }

  /** Maker/checker: the approver cannot be the creator (§16.4 separation). */
  async approve(runId: string, approverId: string) {
    const run = await this.detail(runId)
    if (run.status !== 'draft') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    if (run.createdBy === approverId) {
      throw new BadRequestException('Maker and checker must differ')
    }
    return db.paymentRun.update({
      where: { id: runId },
      data: {
        status: 'approved',
        approvedBy: approverId,
        approvedAt: new Date(),
      },
    })
  }

  async execute(runId: string, executedBy: string) {
    const run = await this.detail(runId)
    if (run.status !== 'approved') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    return db.paymentRun.update({
      where: { id: runId },
      data: { status: 'executed', executedBy, executedAt: new Date() },
    })
  }

  /**
   * Reconcile one supplier line back from the bank/ERP after finance executes
   * the hand-off. Paid flips the invoice to paid; when every line is
   * reconciled the run closes (reconciledAt).
   */
  async reconcile(
    runId: string,
    lineId: string,
    status: 'paid' | 'dishonored' | 'rejected',
  ) {
    const run = await this.detail(runId)
    if (run.status !== 'executed') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    const line = await db.paymentRunLine.findUnique({ where: { id: lineId } })
    if (!line || line.runId !== runId) {
      throw new NotFoundException(
        `Line ${lineId} is not on run ${run.runNumber}`,
      )
    }

    return db.$transaction(async (tx) => {
      await tx.paymentRunLine.update({
        where: { id: lineId },
        data: { status: status as PaymentStatus },
      })
      if (status === 'paid') {
        await tx.invoice.update({
          where: { id: line.invoiceId },
          data: { status: 'paid' },
        })
      }
      const remaining = await tx.paymentRunLine.count({
        where: { runId, status: { notIn: ['paid', 'dishonored', 'rejected'] } },
      })
      if (remaining === 0) {
        await tx.paymentRun.update({
          where: { id: runId },
          data: { status: 'reconciled', reconciledAt: new Date() },
        })
      }
      return {
        lineId,
        status,
        runStatus: remaining === 0 ? 'reconciled' : run.status,
      }
    })
  }

  async voidRun(runId: string) {
    const run = await this.detail(runId)
    if (run.status !== 'draft' && run.status !== 'approved') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    return db.paymentRun.update({
      where: { id: runId },
      data: { status: 'voided' },
    })
  }

  list(where: { status?: PaymentRunStatus } = {}) {
    return db.paymentRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { lines: true },
    })
  }

  async detail(runId: string) {
    const run = await db.paymentRun.findUnique({
      where: { id: runId },
      include: { lines: true },
    })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    return run
  }
}
