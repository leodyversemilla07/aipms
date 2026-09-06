import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type InvoiceStatus, Prisma } from '@workspace/db'
import { computeTax } from '@workspace/tax'
import { PolicyService } from '../policy/policy.service'
import { EventEmitterService } from '../shared/events/event-emitter.service'

/** §9 3-way match tolerance: ± this much (basis points) is a clean match. */
export const MATCH_TOLERANCE_BPS = 500 // 5%

export interface RegisterInvoiceLineInput {
  description?: string
  amountMinor: number
  class: 'goods' | 'services' | 'professional' | 'rental' | 'other'
  vatExempt?: boolean
}

export interface RegisterInvoiceInput {
  vendorId: string
  number: string
  poId?: string | null
  currencyCode?: string
  lines: RegisterInvoiceLineInput[]
  receivedAt?: Date
}

export type MatchOutcome =
  | 'matched'
  | 'po_not_found'
  | 'po_not_live'
  | 'vendor_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  | 'awaiting_receipt'
  | 'receipt_shortfall'
  | 'over_allocated'

export type MatchResult = {
  poId: string | null
  poTotalMinor: number | null
  invoiceTotalMinor: number
  varianceMinor: number
  varianceBps: number | null
  vendorMatched: boolean
  amountMatched: boolean
  outcome: MatchOutcome
  /** §8.1 value of recorded receipts against the PO, at PO line prices. */
  receivedValueMinor: number | null
  /**
   * Value already reserved by other matched/paid invoices on this PO.
   * Receipt coverage and PO capacity are evaluated against what remains,
   * so one PO/receipt value cannot make two invoices independently payable.
   */
  allocatedMinor: number | null
}

@Injectable()
export class InvoiceService {
  constructor(
    private readonly policy: PolicyService,
    private readonly events: EventEmitterService,
  ) {}

  /**
   * §8.4 compute tax for a line set without persisting — the surface the agent
   * calls to *explain* a net amount; it never computes the number itself.
   */
  async compute(input: { lines: RegisterInvoiceLineInput[] }) {
    const taxConfig = await this.policy.taxConfig()
    const computation = computeTax(input.lines, taxConfig)
    return {
      taxPolicyVersion: computation.policyVersion,
      ...computation,
    }
  }

  list(where: { status?: InvoiceStatus } = {}) {
    return db.invoice.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
    })
  }

  async detail(id: string) {
    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) throw new NotFoundException(`Invoice ${id} not found`)
    return invoice
  }

  /**
   * Register an extracted supplier invoice: compute VAT/EWT deterministically
   * (§8.4) and run the §9 three-way match against the PO. Money is never
   * double-entered by an agent — the engine derives every tax field.
   */
  async register(
    input: RegisterInvoiceInput,
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ invoice: unknown; match: MatchResult | null }> {
    const taxConfig = await this.policy.taxConfig()
    const computation = computeTax(input.lines, taxConfig)

    // Match and create atomically: the PO row lock serializes concurrent
    // registrations against the same PO so two invoices cannot consume the
    // same receipt/PO capacity (see matchAgainstPo allocation).
    const run = async (client: Prisma.TransactionClient) => {
      if (input.poId != null) {
        await client.$queryRaw`SELECT id FROM "purchaseOrder" WHERE id = ${input.poId} FOR UPDATE`
      }

      // Dedupe up front: [vendorId, number] is unique, and a unique
      // violation would abort an outer transaction, so never race the insert.
      const duplicate = await client.invoice.findUnique({
        where: {
          vendorId_number: { vendorId: input.vendorId, number: input.number },
        },
      })
      if (duplicate) {
        return {
          invoice: duplicate,
          match:
            (duplicate.matchResult as unknown as MatchResult | null) ?? null,
        }
      }

      const match =
        input.poId != null
          ? await this.matchAgainstPo(
              {
                poId: input.poId,
                vendorId: input.vendorId,
                totalMinor: computation.grossMinor,
                currencyCode: input.currencyCode ?? 'PHP',
              },
              client,
            )
          : null

      const status: InvoiceStatus = match
        ? InvoiceService.statusFor(match)
        : 'received'
      const data = {
        poId: input.poId ?? null,
        vendorId: input.vendorId,
        number: input.number,
        amountMinor: computation.grossMinor,
        vatMinor: computation.vatMinor,
        ewtMinor: computation.ewtMinor,
        currencyCode: input.currencyCode ?? 'PHP',
        taxPolicyVersion: computation.policyVersion,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : undefined,
        status,
        matchResult: match ?? undefined,
      }

      // A concurrent insert between the pre-check and this create surfaces as
      // P2002; the caller retries the idempotency key, and the pre-check then
      // returns the winner's row. Never swallow it into a second read here —
      // inside an outer transaction the transaction is already aborted.
      const invoice = await client.invoice.create({ data })
      await this.events.emit(
        {
          type: 'invoice.received',
          entityType: 'Invoice',
          entityId: invoice.id,
          payload: { vendorId: invoice.vendorId, number: invoice.number },
        },
        client,
      )
      await this.emitStatusEvents(invoice.id, status, client)
      return { invoice, match }
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /** §9 three-way match (§8.1): PO ↔ receipts ↔ invoice, at value level.
   *
   * Order of gates: PO existence → PO lifecycle → vendor → currency →
   * PO-amount variance → receipt coverage (against UNALLOCATED received
   * value) → PO capacity (against UNALLOCATED PO total). A clean amount with
   * no receipts yet is `awaiting_receipt` (the invoice stays `received` and
   * is re-matched when a receipt lands); goods worth materially less than
   * the remaining invoice value is a `receipt_shortfall` exception; value
   * already consumed by other matched/paid invoices is `over_allocated`.
   */
  private async matchAgainstPo(
    input: {
      poId: string
      vendorId: string
      totalMinor: number
      currencyCode: string
    },
    client: Prisma.TransactionClient | typeof db = db,
    opts: { excludeInvoiceId?: string } = {},
  ): Promise<MatchResult> {
    const {
      poId,
      vendorId: invoiceVendorId,
      totalMinor: invoiceTotalMinor,
    } = input
    const po = await client.purchaseOrder.findUnique({ where: { id: poId } })
    if (!po) {
      return {
        poId,
        poTotalMinor: null,
        invoiceTotalMinor,
        varianceMinor: 0,
        varianceBps: 0,
        vendorMatched: false,
        amountMatched: false,
        outcome: 'po_not_found',
        receivedValueMinor: null,
        allocatedMinor: null,
      }
    }

    const poTotalMinor = po.totalMinor
    const varianceMinor = invoiceTotalMinor - poTotalMinor
    const varianceBps =
      poTotalMinor > 0
        ? Math.round((Math.abs(varianceMinor) / poTotalMinor) * 10_000)
        : 0

    const vendorMatched = po.vendorId === invoiceVendorId
    const amountMatched = varianceBps <= MATCH_TOLERANCE_BPS

    const base = {
      poId,
      poTotalMinor,
      invoiceTotalMinor,
      varianceMinor,
      varianceBps,
      vendorMatched,
      amountMatched,
      receivedValueMinor: null as number | null,
      allocatedMinor: null as number | null,
    }

    // Invoices only match against a live PO in the invoice currency.
    if (po.status !== 'issued' && po.status !== 'confirmed') {
      return { ...base, outcome: 'po_not_live' }
    }
    if (!vendorMatched) return { ...base, outcome: 'vendor_mismatch' }
    if (po.currencyCode !== input.currencyCode) {
      return { ...base, outcome: 'currency_mismatch' }
    }
    if (!amountMatched) return { ...base, outcome: 'amount_mismatch' }

    // Receipt leg: evaluated against value not already consumed by other
    // matched/paid invoices, so two invoices cannot share one receipt.
    const receivedValueMinor = await this.receivedValueForPo(po.id, client)
    const allocatedMinor = await this.allocatedValueForPo(
      po.id,
      client,
      opts.excludeInvoiceId,
    )
    const remainingReceived = receivedValueMinor - allocatedMinor
    const withReceipts = {
      ...base,
      receivedValueMinor,
      allocatedMinor,
    }
    if (receivedValueMinor === 0) {
      return { ...withReceipts, outcome: 'awaiting_receipt' }
    }
    if (remainingReceived <= 0) {
      // Goods arrived but other invoices already consume their full value.
      return { ...withReceipts, outcome: 'over_allocated' }
    }
    if (InvoiceService.overTolerance(invoiceTotalMinor, remainingReceived)) {
      return { ...withReceipts, outcome: 'receipt_shortfall' }
    }

    // PO capacity leg: the same goods cannot also exceed what the PO still
    // has unreserved.
    const poRemaining = poTotalMinor - allocatedMinor
    if (InvoiceService.overTolerance(invoiceTotalMinor, poRemaining)) {
      return { ...withReceipts, outcome: 'over_allocated' }
    }

    return { ...withReceipts, outcome: 'matched' }
  }

  /** True when `total` differs from `reference` beyond match tolerance. */
  private static overTolerance(totalMinor: number, referenceMinor: number) {
    return (
      Math.round(
        (Math.abs(totalMinor - referenceMinor) / Math.max(totalMinor, 1)) *
          10_000,
      ) > MATCH_TOLERANCE_BPS
    )
  }

  /**
   * Value already reserved by other matched/paid invoices on a PO. Paid
   * invoices count: the money left against that value. `excludeInvoiceId`
   * re-evaluates one invoice without its own reservation blocking itself.
   */
  private async allocatedValueForPo(
    poId: string,
    client: Prisma.TransactionClient | typeof db,
    excludeInvoiceId?: string,
  ): Promise<number> {
    const holders = await client.invoice.findMany({
      where: {
        poId,
        status: { in: ['matched', 'paid'] },
        ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      },
      select: { amountMinor: true },
    })
    return holders.reduce((sum, row) => sum + row.amountMinor, 0)
  }

  /**
   * Value of recorded receipts for a PO, priced at the referenced PO lines.
   * Free-text receipt lines that reference no known PO line contribute 0 —
   * an under-count is conservative (it can only raise exceptions, never
   * silently pass a match).
   */
  private async receivedValueForPo(
    poId: string,
    client: Prisma.TransactionClient | typeof db = db,
  ): Promise<number> {
    const [receipts, poLines] = await Promise.all([
      client.receipt.findMany({
        where: { poId, status: 'recorded' },
        select: { lines: { select: { quantity: true, lineNo: true } } },
      }),
      client.purchaseOrderLine.findMany({
        where: { poId },
        select: { lineNo: true, unitPriceMinor: true },
      }),
    ])
    const priceByLineNo = new Map(
      poLines.map((l) => [l.lineNo, l.unitPriceMinor] as const),
    )
    let total = 0
    for (const receipt of receipts) {
      for (const line of receipt.lines) {
        const price =
          line.lineNo != null ? priceByLineNo.get(line.lineNo) : undefined
        total += line.quantity * (price ?? 0)
      }
    }
    return total
  }

  /** §10.2 lifecycle mapping from a gate outcome to the invoice status. */
  private static statusFor(match: MatchResult): InvoiceStatus {
    switch (match.outcome) {
      case 'matched':
        return 'matched'
      case 'awaiting_receipt':
        // Clean against the PO but no goods booked yet — wait, do not block.
        return 'received'
      default:
        return 'exception'
    }
  }

  private async emitStatusEvents(
    id: string,
    status: InvoiceStatus,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (status === 'matched') {
      await this.events.emit(
        {
          type: 'invoice.matched',
          entityType: 'Invoice',
          entityId: id,
          payload: { status: 'matched' },
        },
        tx,
      )
    } else if (status === 'exception') {
      await this.events.emit(
        {
          type: 'invoice.exception',
          entityType: 'Invoice',
          entityId: id,
          payload: { status: 'exception' },
        },
        tx,
      )
    }
  }

  /**
   * §8.1 re-match open invoices after a receipt is recorded: invoices parked
   * as `received` (awaiting_receipt) get a fresh three-way evaluation, and so
   * do `receipt_shortfall` exceptions — the shortfall may be cured by the
   * goods that just landed. Other exception outcomes stay parked for humans.
   * Oldest invoices claim remaining capacity first.
   */
  async rematchOpenForPo(
    poId: string,
    outerTx?: Prisma.TransactionClient,
  ): Promise<RematchSummary> {
    const client = outerTx ?? db
    const open = await client.invoice.findMany({
      where: {
        poId,
        OR: [
          { status: 'received' },
          {
            status: 'exception',
            matchResult: { path: ['outcome'], equals: 'receipt_shortfall' },
          },
        ],
      },
      orderBy: { receivedAt: 'asc' },
    })
    const summary: RematchSummary = {
      considered: open.length,
      matched: 0,
      stillWaiting: 0,
      exceptions: 0,
    }
    for (const invoice of open) {
      const match = await this.matchAgainstPo(
        {
          poId,
          vendorId: invoice.vendorId,
          totalMinor: invoice.amountMinor,
          currencyCode: invoice.currencyCode,
        },
        client,
      )
      const status = InvoiceService.statusFor(match)
      await client.invoice.update({
        where: { id: invoice.id },
        data: {
          status,
          matchResult: match as unknown as Prisma.InputJsonValue,
        },
      })
      await this.emitStatusEvents(invoice.id, status, outerTx)
      if (status === 'matched') summary.matched += 1
      else if (status === 'exception') summary.exceptions += 1
      else summary.stillWaiting += 1
    }
    return summary
  }

  /**
   * Re-evaluate matched invoices after their supporting receipt changed
   * (receipt cancellation). Invoices whose match no longer holds are demoted
   * atomically with the caller's change; invoices claimed by a live payment
   * run block the operation instead — void or resolve the run first.
   */
  async reevaluateMatchedForPo(
    poId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReevaluateSummary> {
    const matched = await tx.invoice.findMany({
      where: { poId, status: 'matched' },
      orderBy: { receivedAt: 'asc' },
    })
    const ids = matched.map((row) => row.id)
    if (ids.length > 0) {
      // Same active-reservation definition as payment-run creation: a
      // planned line on a live run. Released claims (voided runs,
      // terminally reconciled lines) do not block corrections.
      const claimed = await tx.paymentRunLine.findMany({
        where: {
          invoiceId: { in: ids },
          status: 'planned',
          run: { status: { not: 'voided' } },
        },
        include: { run: { select: { runNumber: true, status: true } } },
      })
      if (claimed.length > 0) {
        const first = claimed[0]
        if (!first) throw new ConflictException('Payment claim changed')
        const invoice = matched.find((row) => row.id === first.invoiceId)
        throw new ConflictException(
          `Invoice ${invoice?.number ?? first.invoiceId} is claimed by payment run ${first.run.runNumber} (${first.run.status}) — resolve the run before changing its supporting receipts`,
        )
      }
    }

    const summary: ReevaluateSummary = {
      considered: matched.length,
      kept: 0,
      demoted: 0,
    }
    for (const invoice of matched) {
      const match = await this.matchAgainstPo(
        {
          poId,
          vendorId: invoice.vendorId,
          totalMinor: invoice.amountMinor,
          currencyCode: invoice.currencyCode,
        },
        tx,
        { excludeInvoiceId: invoice.id },
      )
      if (match.outcome === 'matched') {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { matchResult: match as unknown as Prisma.InputJsonValue },
        })
        summary.kept += 1
        continue
      }
      const status = InvoiceService.statusFor(match)
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          status,
          matchResult: match as unknown as Prisma.InputJsonValue,
        },
      })
      await this.emitStatusEvents(invoice.id, status, tx)
      summary.demoted += 1
    }
    return summary
  }
}

export interface RematchSummary {
  considered: number
  matched: number
  stillWaiting: number
  exceptions: number
}

export interface ReevaluateSummary {
  considered: number
  kept: number
  demoted: number
}
