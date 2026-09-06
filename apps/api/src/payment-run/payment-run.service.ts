import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import {
  db,
  type PaymentRunStatus,
  type PaymentStatus,
  Prisma,
} from '@workspace/db'
import { DocumentNumberService } from '../shared/document-number/document-number.service'
import { type BuiltBatch, buildPaymentBatch } from './batch'
import {
  freezeBeneficiary,
  readBeneficiarySnapshot,
} from './beneficiary-snapshot'
import { buildPain001, resolveDebtor } from './pain001'

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
 * - Claims are reservations, not history: a planned line on a live run
 *   blocks replanning, but voided runs and terminally reconciled lines
 *   release their invoices so corrected replacement runs can proceed. Paid
 *   invoices stay paid and are never replannable.
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

  async create(
    input: CreateRunInput,
    createdBy: string,
    outerTx?: Prisma.TransactionClient,
  ) {
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

    // §8.6 race-hardened create: invoice eligibility is re-checked inside the
    // transaction under FOR UPDATE row locks (serializes concurrent creates
    // claiming the same invoices), and the run number is minted in the same
    // transaction — a runNumber collision retries with a fresh number.
    // With an outer (idempotent/atomic) transaction a collision aborts the
    // whole transaction, so attempt once and let the caller retry the key.
    const attempt = async (tx: Prisma.TransactionClient) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "invoice" WHERE id IN (${Prisma.join(uniqueIds)}) FOR UPDATE`,
      )
      if (locked.length !== uniqueIds.length) {
        throw new NotFoundException('One or more invoices do not exist')
      }

      // Only matched invoices are payable; anything already reserved by a
      // live run is refused. Reservations release: voided runs and
      // terminally reconciled lines (paid/dishonored/rejected) no longer
      // claim — paid invoices are still refused by the status gate above,
      // while dishonored/rejected/voided invoices return to the pool so a
      // corrected replacement run can proceed.
      const fresh = await tx.invoice.findMany({
        where: { id: { in: uniqueIds } },
      })
      for (const invoice of fresh) {
        if (invoice.status !== 'matched') {
          throw new BadRequestException(
            `Invoice ${invoice.number} is ${invoice.status}, not payable`,
          )
        }
      }
      const freshVendorIds = [
        ...new Set(fresh.map((invoice) => invoice.vendorId)),
      ].sort()
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM vendor WHERE id IN (${Prisma.join(freshVendorIds)}) ORDER BY id FOR UPDATE`,
      )
      const freshVendors = await tx.vendor.findMany({
        where: { id: { in: freshVendorIds } },
      })
      const snapshots = new Map(
        fresh.map((invoice) => {
          const vendor = freshVendors.find((row) => row.id === invoice.vendorId)
          if (!vendor) throw new NotFoundException('Invoice vendor not found')
          try {
            return [
              invoice.id,
              freezeBeneficiary(invoice.number, vendor),
            ] as const
          } catch (error) {
            throw new BadRequestException(
              error instanceof Error ? error.message : 'Invalid beneficiary',
            )
          }
        }),
      )
      if (fresh.some((invoice) => invoice.currencyCode !== 'PHP')) {
        throw new BadRequestException(
          'Payment runs currently support PHP invoices only',
        )
      }
      const netByInvoice = new Map(
        fresh.map((invoice) => [invoice.id, this.netPayable(invoice)]),
      )
      const totalMinor = [...netByInvoice.values()].reduce(
        (sum, amount) => sum + amount,
        0,
      )
      const claimed = await tx.paymentRunLine.findMany({
        where: {
          invoiceId: { in: uniqueIds },
          status: 'planned',
          run: { status: { not: 'voided' } },
        },
        select: { invoiceId: true },
      })
      if (claimed.length > 0) {
        throw new ConflictException(
          'One or more invoices are reserved by a live payment run',
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
            create: fresh.map((invoice) => ({
              invoiceId: invoice.id,
              beneficiarySnapshot: snapshots.get(invoice.id),
              netMinor: netByInvoice.get(invoice.id) ?? 0,
              status: 'planned',
            })),
          },
        },
        include: { lines: true },
      })
      return { run, netMinor: totalMinor }
    }
    if (outerTx) return attempt(outerTx)
    for (let retries = 0; ; retries++) {
      try {
        return await db.$transaction(attempt)
      } catch (error) {
        const target = (error as { meta?: { target?: unknown } }).meta?.target
        const isRunNumberCollision =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          Array.isArray(target) &&
          target.includes('runNumber')
        if (isRunNumberCollision && retries < 3) continue
        throw error
      }
    }
  }

  /** Maker/checker: the approver cannot be the creator (§16.4 separation). */
  async approve(
    runId: string,
    approverId: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const run = await tx.paymentRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    if (run.status !== 'draft') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    if (run.createdBy === approverId) {
      throw new BadRequestException('Maker and checker must differ')
    }
    const changed = await tx.paymentRun.updateMany({
      where: { id: runId, status: 'draft', createdBy: { not: approverId } },
      data: {
        status: 'approved',
        approvedBy: approverId,
        approvedAt: new Date(),
      },
    })
    if (changed.count !== 1)
      throw new ConflictException(
        'Payment run changed; reload before approving',
      )
    const approved = await tx.paymentRun.findUniqueOrThrow({
      where: { id: runId },
      include: { lines: true },
    })
    return approved
  }

  async execute(
    runId: string,
    executedBy: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const run = await tx.paymentRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    if (run.status !== 'approved') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    const changed = await tx.paymentRun.updateMany({
      where: { id: runId, status: 'approved' },
      data: { status: 'executed', executedBy, executedAt: new Date() },
    })
    if (changed.count !== 1)
      throw new ConflictException(
        'Payment run changed; reload before executing',
      )
    return tx.paymentRun.findUniqueOrThrow({
      where: { id: runId },
      include: { lines: true },
    })
  }

  /**
   * §8.6 hand-off artifact — the normalized PESONet batch file finance
   * imports into the org's bank portal. Generation requires an approved or
   * executed run (drafts are not binding; voided runs never pay) and is
   * deterministic from frozen data, so regeneration yields byte-identical
   * output (sha256 tamper-evidence). Beneficiary details are copied from the
   * vendor master's verified bank account; any unusable account refuses the
   * whole batch rather than producing partial payment instructions.
   */
  async generateBatch(runId: string): Promise<{
    runNumber: string
    status: string
    currencyCode: string
    totalMinor: number
    lineCount: number
    sha256: string
    json: string
    csv: string
    /** ISO 20022 pain.001.08 — null until AIPMS_PAYMENT_DEBTOR_NAME/ACCOUNT are set. */
    pain001: string | null
  }> {
    const run = await db.paymentRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    if (run.status !== 'approved' && run.status !== 'executed') {
      throw new ConflictException(
        `Run ${run.runNumber} is ${run.status} — only approved or executed runs produce a payment batch`,
      )
    }

    const lines = await db.paymentRunLine.findMany({ where: { runId } })
    let built: BuiltBatch
    try {
      built = buildPaymentBatch({
        runNumber: run.runNumber,
        executedAt: run.createdAt,
        currencyCode: run.currencyCode,
        totalMinor: run.totalMinor,
        lines: lines.map((line) => {
          const snapshot = readBeneficiarySnapshot(line.beneficiarySnapshot)
          return {
            ...snapshot,
            lineId: line.id,
            invoiceId: line.invoiceId,
            netMinor: line.netMinor,
            currencyCode: run.currencyCode,
          }
        }),
      })
    } catch (error) {
      // Builder failures (unusable beneficiaries, Σ mismatch) are domain
      // refusals — surface as 400/409-shaped BadRequest, fail visible.
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      )
    }

    // Same frozen data, standards-shaped rail. The debtor (paying org) is
    // instance configuration; without it the CSV hand-off still works and
    // pain.001 is withheld rather than emitted with placeholder payer details.
    const debtor = resolveDebtor()
    const pain = debtor ? buildPain001(built.manifest, debtor) : null

    return {
      runNumber: run.runNumber,
      status: run.status,
      currencyCode: run.currencyCode,
      totalMinor: run.totalMinor,
      lineCount: lines.length,
      sha256: built.sha256,
      json: built.json,
      csv: built.csv,
      pain001: pain?.xml ?? null,
    }
  }

  /**
   * Reconcile one supplier line back from the bank/ERP after finance executes
   * the hand-off. Paid flips the invoice to paid; dishonored/rejected leave
   * the invoice matched and release its reservation for a replacement run.
   * When every line is reconciled the run closes (reconciledAt).
   *
   * Serialized at the run row: concurrent reconciliations of different lines
   * count a consistent committed state, so the last close cannot be lost.
   * Line transitions are conditional (planned → terminal only): a decided
   * line never moves again, so a paid line and its paid invoice cannot be
   * rewritten to a contradictory outcome.
   */
  async reconcile(
    runId: string,
    lineId: string,
    status: 'paid' | 'dishonored' | 'rejected',
    outerTx?: Prisma.TransactionClient,
  ) {
    const runTx = async (tx: Prisma.TransactionClient) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "paymentRun" WHERE id = ${runId} FOR UPDATE`,
      )
      if (locked.length !== 1) {
        throw new NotFoundException(`Payment run ${runId} not found`)
      }
      const run = await tx.paymentRun.findUniqueOrThrow({
        where: { id: runId },
      })
      if (run.status !== 'executed') {
        throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
      }
      const line = await tx.paymentRunLine.findUnique({
        where: { id: lineId },
      })
      if (!line || line.runId !== runId) {
        throw new NotFoundException(
          `Line ${lineId} is not on run ${run.runNumber}`,
        )
      }

      const decided = await tx.paymentRunLine.updateMany({
        where: { id: lineId, status: 'planned' },
        data: { status: status as PaymentStatus },
      })
      if (decided.count !== 1) {
        throw new ConflictException(
          `Line ${lineId} is already reconciled — reload before deciding`,
        )
      }
      if (status === 'paid') {
        await tx.invoice.update({
          where: { id: line.invoiceId },
          data: { status: 'paid' },
        })
      }
      const remaining = await tx.paymentRunLine.count({
        where: { runId, status: 'planned' },
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
    }
    if (outerTx) return runTx(outerTx)
    return db.$transaction(runTx)
  }

  async voidRun(runId: string, tx: Prisma.TransactionClient = db) {
    const run = await tx.paymentRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    if (run.status !== 'draft' && run.status !== 'approved') {
      throw new ConflictException(`Run ${run.runNumber} is ${run.status}`)
    }
    const changed = await tx.paymentRun.updateMany({
      where: { id: runId, status: { in: ['draft', 'approved'] } },
      data: { status: 'voided' },
    })
    if (changed.count !== 1)
      throw new ConflictException('Payment run changed; reload before voiding')
    return tx.paymentRun.findUniqueOrThrow({ where: { id: runId } })
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
