import { Injectable, NotFoundException } from '@nestjs/common'
import { db } from '@workspace/db'
import type { ListInput, ListResult } from '../trpc/list-input'
import { paginate } from '../trpc/list-input'

/**
 * §8.4 BIR statutory reports — deterministic generation from stored invoice
 * tax data, never an LLM computation (the agent only requests and explains).
 *
 *  - **BIR Form 2307** — Certificate of Creditable Tax Withheld at Source:
 *    per supplier per period (month), one line per withheld invoice.
 *  - **BIR Form 1601-E** — Monthly Remittance Return of Creditable Income
 *    Taxes Withheld (Expanded): per period, aggregated per supplier.
 *
 * Money is minor-unit integers; the base for withholding is the invoice's
 * VAT-exclusive gross (`amountMinor`), exactly what the §8.4 tax engine
 * computed EWT against at registration time. `taxPolicyVersion` travels with
 * every figure so a certificate cites the rates it was computed under.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function assertPeriod(period: string): void {
  if (!PERIOD_RE.test(period)) {
    throw new NotFoundException(
      `Invalid period '${period}' — expected YYYY-MM (e.g. 2026-01)`,
    )
  }
}

function periodRange(period: string): { gte: Date; lt: Date } {
  const [y, m] = period
    .split('-')
    .map((part) => Number.parseInt(part, 10))
  return {
    gte: new Date(Date.UTC(y, m - 1, 1)),
    lt: new Date(Date.UTC(y, m, 1)),
  }
}

export interface Bir2307Line {
  invoiceId: string
  number: string
  receivedAt: Date
  baseAmountMinor: number
  ewtMinor: number
  taxPolicyVersion: string | null
}

export interface Bir2307 {
  form: '2307'
  period: string
  vendor: {
    id: string
    name: string
    taxId: string | null
    email: string | null
  }
  lines: Bir2307Line[]
  totals: {
    baseAmountMinor: number
    taxWithheldMinor: number
  }
}

export interface Bir1601ESupplierRow {
  vendorId: string
  name: string
  taxId: string | null
  invoiceCount: number
  baseAmountMinor: number
  taxWithheldMinor: number
}

export interface Bir1601E {
  form: '1601-E'
  period: string
  suppliers: Bir1601ESupplierRow[]
  totals: {
    invoiceCount: number
    baseAmountMinor: number
    taxWithheldMinor: number
  }
}

@Injectable()
export class BirService {
  /** Invoices with EWT withheld in the period, oldest first (form order). */
  private async withheldInPeriod(vendorId: string | undefined, period: string) {
    assertPeriod(period)
    const invoices = await db.invoice.findMany({
      where: {
        receivedAt: periodRange(period),
        ...(vendorId ? { vendorId } : {}),
        ewtMinor: { gt: 0 },
      },
      orderBy: [{ vendorId: 'asc' }, { receivedAt: 'asc' }],
    })
    // Invoice carries a plain vendorId string (no Prisma relation) — join the
    // master data in a second query.
    const vendorIds = [...new Set(invoices.map((i) => i.vendorId))]
    const vendors = vendorIds.length
      ? await db.vendor.findMany({
          where: { id: { in: vendorIds } },
          select: { id: true, name: true, taxId: true, email: true },
        })
      : []
    const byId = new Map(vendors.map((v) => [v.id, v] as const))
    return invoices.map((inv) => ({
      ...inv,
      vendor:
        byId.get(inv.vendorId) ??
        ({ id: inv.vendorId, name: '(deleted)', taxId: null, email: null } as const),
    }))
  }

  /**
   * §8.4 Certificate of Creditable Tax Withheld at Source for one supplier
   * and month.
   */
  async form2307(input: {
    vendorId: string
    period: string
  }): Promise<Bir2307> {
    const vendor = await db.vendor.findUnique({
      where: { id: input.vendorId },
      select: { id: true, name: true, taxId: true, email: true },
    })
    if (!vendor) throw new NotFoundException(`Vendor ${input.vendorId} not found`)

    const invoices = await this.withheldInPeriod(vendor.id, input.period)
    const lines: Bir2307Line[] = invoices.map((inv) => ({
      invoiceId: inv.id,
      number: inv.number,
      receivedAt: inv.receivedAt,
      baseAmountMinor: inv.amountMinor,
      ewtMinor: inv.ewtMinor,
      taxPolicyVersion: inv.taxPolicyVersion,
    }))

    return {
      form: '2307',
      period: input.period,
      vendor,
      lines,
      totals: {
        baseAmountMinor: lines.reduce((s, l) => s + l.baseAmountMinor, 0),
        taxWithheldMinor: lines.reduce((s, l) => s + l.ewtMinor, 0),
      },
    }
  }

  /**
   * §8.4 Monthly remittance summary: all creditable withholding for a month,
   * aggregated per supplier.
   */
  async summary1601e(input: { period: string }): Promise<Bir1601E> {
    const invoices = await this.withheldInPeriod(undefined, input.period)

    const byVendor = new Map<string, Bir1601ESupplierRow>()
    for (const inv of invoices) {
      let row = byVendor.get(inv.vendorId)
      if (!row) {
        row = {
          vendorId: inv.vendorId,
          name: inv.vendor.name,
          taxId: inv.vendor.taxId,
          invoiceCount: 0,
          baseAmountMinor: 0,
          taxWithheldMinor: 0,
        }
        byVendor.set(inv.vendorId, row)
      }
      row.invoiceCount += 1
      row.baseAmountMinor += inv.amountMinor
      row.taxWithheldMinor += inv.ewtMinor
    }

    const suppliers = [...byVendor.values()]
    return {
      form: '1601-E',
      period: input.period,
      suppliers,
      totals: {
        invoiceCount: suppliers.reduce((s, r) => s + r.invoiceCount, 0),
        baseAmountMinor: suppliers.reduce((s, r) => s + r.baseAmountMinor, 0),
        taxWithheldMinor: suppliers.reduce((s, r) => s + r.taxWithheldMinor, 0),
      },
    }
  }

  /** Periods that have withholding data (drives UI period pickers). */
  async list(
    input: Partial<ListInput> = {},
  ): Promise<ListResult<{ period: string; taxWithheldMinor: number; invoiceCount: number }>> {
    const { skip, take } = paginate({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    })
    const rows = await db.invoice.findMany({
      where: { ewtMinor: { gt: 0 } },
      select: { receivedAt: true, ewtMinor: true },
    })
    const acc = new Map<string, { period: string; taxWithheldMinor: number; invoiceCount: number }>()
    for (const r of rows) {
      const period = r.receivedAt.toISOString().slice(0, 7)
      const row = acc.get(period) ?? { period, taxWithheldMinor: 0, invoiceCount: 0 }
      row.taxWithheldMinor += r.ewtMinor
      row.invoiceCount += 1
      acc.set(period, row)
    }
    const sorted = [...acc.values()].sort((a, b) => b.period.localeCompare(a.period))
    return {
      rows: sorted.slice(skip, skip + take),
      total: sorted.length,
      facetCounts: {},
    }
  }
}
