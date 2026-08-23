import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type InvoiceStatus } from '@workspace/db'
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
  | 'vendor_mismatch'
  | 'amount_mismatch'
  | 'awaiting_receipt'
  | 'receipt_shortfall'

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
  ): Promise<{ invoice: unknown; match: MatchResult | null }> {
    const taxConfig = await this.policy.taxConfig()
    const computation = computeTax(input.lines, taxConfig)

    const match =
      input.poId != null
        ? await this.matchAgainstPo(
            input.poId,
            input.vendorId,
            computation.grossMinor,
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

    let invoice: Awaited<ReturnType<typeof db.invoice.create>>
    try {
      invoice = await db.invoice.create({ data })
      await this.events.emit({
        type: 'invoice.received',
        entityType: 'Invoice',
        entityId: invoice.id,
        payload: { vendorId: invoice.vendorId, number: invoice.number },
      })
      await this.emitStatusEvents(invoice.id, status)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        // [vendorId, number] already ingested — dedupe to the existing row.
        const existing = await db.invoice.findUnique({
          where: {
            vendorId_number: { vendorId: input.vendorId, number: input.number },
          },
        })
        if (!existing) throw new ConflictException('Duplicate invoice')
        return {
          invoice: existing,
          match:
            (existing.matchResult as unknown as MatchResult | null) ?? null,
        }
      }
      throw error
    }
    return { invoice, match }
  }

  /** §9 three-way match (§8.1): PO ↔ receipts ↔ invoice, at value level.
   *
   * Order of gates: PO existence → vendor → PO-amount variance → receipt
   * coverage. A clean amount with no receipts yet is `awaiting_receipt` (the
   * invoice stays `received` and is re-matched when a receipt lands); goods
   * worth materially less than invoiced is a `receipt_shortfall` exception.
   */
  private async matchAgainstPo(
    poId: string,
    invoiceVendorId: string,
    invoiceTotalMinor: number,
  ): Promise<MatchResult> {
    const po = await db.purchaseOrder.findUnique({ where: { id: poId } })
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

    let outcome: MatchOutcome = 'matched'
    if (!vendorMatched) outcome = 'vendor_mismatch'
    else if (!amountMatched) outcome = 'amount_mismatch'

    // Receipt leg: only evaluated once vendor and PO amount are clean.
    let receivedValueMinor: number | null = null
    if (outcome === 'matched') {
      receivedValueMinor = await this.receivedValueForPo(po.id)
      if (receivedValueMinor === 0) {
        outcome = 'awaiting_receipt'
      } else if (
        Math.round(
          ((invoiceTotalMinor - receivedValueMinor) /
            Math.max(invoiceTotalMinor, 1)) *
            10_000,
        ) > MATCH_TOLERANCE_BPS
      ) {
        outcome = 'receipt_shortfall'
      }
    }

    return {
      poId,
      poTotalMinor,
      invoiceTotalMinor,
      varianceMinor,
      varianceBps,
      vendorMatched,
      amountMatched,
      outcome,
      receivedValueMinor,
    }
  }

  /**
   * Value of recorded receipts for a PO, priced at the referenced PO lines.
   * Free-text receipt lines that reference no known PO line contribute 0 —
   * an under-count is conservative (it can only raise exceptions, never
   * silently pass a match).
   */
  private async receivedValueForPo(poId: string): Promise<number> {
    const [receipts, poLines] = await Promise.all([
      db.receipt.findMany({
        where: { poId, status: 'recorded' },
        select: { lines: { select: { quantity: true, lineNo: true } } },
      }),
      db.purchaseOrderLine.findMany({
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
  ): Promise<void> {
    if (status === 'matched') {
      await this.events.emit({
        type: 'invoice.matched',
        entityType: 'Invoice',
        entityId: id,
        payload: { status: 'matched' },
      })
    } else if (status === 'exception') {
      await this.events.emit({
        type: 'invoice.exception',
        entityType: 'Invoice',
        entityId: id,
        payload: { status: 'exception' },
      })
    }
  }

  /**
   * §8.1 re-match open invoices after a receipt is recorded: invoices parked
   * as `received` (awaiting_receipt) get a fresh three-way evaluation; newly
   * matched ones flow on to payment planning.
   */
  async rematchOpenForPo(poId: string): Promise<RematchSummary> {
    const open = await db.invoice.findMany({
      where: { poId, status: 'received' },
    })
    const summary: RematchSummary = {
      considered: open.length,
      matched: 0,
      stillWaiting: 0,
      exceptions: 0,
    }
    for (const invoice of open) {
      const match = await this.matchAgainstPo(
        poId,
        invoice.vendorId,
        invoice.amountMinor,
      )
      const status = InvoiceService.statusFor(match)
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status, matchResult: match },
      })
      await this.emitStatusEvents(invoice.id, status)
      if (status === 'matched') summary.matched += 1
      else if (status === 'exception') summary.exceptions += 1
      else summary.stillWaiting += 1
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
