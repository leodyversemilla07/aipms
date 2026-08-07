/**
 * §8.4 deterministic PH tax engine — pure, unit-testable, no I/O, no LLM.
 *
 * Computes Philippine input VAT (12%, RA 9337) and creditable withholding
 * (EWT) from a set of invoice lines, given a configurable tax policy. The
 * agent only routes and explains; it never computes tax.
 *
 * Money is minor-unit integers (centavos) everywhere. Rounding is applied per
 * line and to the totals (round half up on the accumulated value).
 */

export type TaxClass =
  | "goods"
  | "services"
  | "professional"
  | "rental"
  | "other"

export interface TaxLine {
  /** VAT-exclusive gross for this line, in minor units. */
  amountMinor: number
  class: TaxClass
  /** VAT-exempt (e.g. statutory exemptions under RA 9337). */
  vatExempt?: boolean
}

export interface TaxPolicyConfig {
  /** VAT rate in basis points; 1200 = 12%. */
  vatRateBps: number
  /** EWT rate in basis points by class (goods 100 = 1%, services 200 = 2%). */
  ewtRatesBps: Partial<Record<TaxClass, number>>
  /** Human/edition tag, e.g. "ph-v1". */
  version?: string
}

export interface TaxLineComputation {
  amountMinor: number
  vatMinor: number
  ewtMinor: number
}

export interface TaxComputation {
  policyVersion: string | null
  grossMinor: number
  vatableMinor: number
  vatMinor: number
  ewtMinor: number
  /** gross + VAT − EWT = what the buyer funds net of source withholding. */
  netPayableMinor: number
  lines: TaxLineComputation[]
}

export function roundMinor(value: number): number {
  return Math.round(value)
}

function pctBps(amountMinor: number, bps: number | undefined): number {
  return bps ? roundMinor((amountMinor * bps) / 10_000) : 0
}

/**
 * Compute tax for a set of invoice lines.
 *
 * - VAT: applied to vatable lines only (a line is vatable when not flagged
 *   exempt and has a positive amount). EWT is withheld on the VAT-exclusive
 *   amount of every class with a configured EWT rate.
 * - netPayable = gross + vat − ewt, matching §8.4's "gross including VAT
 *   position − withholding".
 */
export function computeTax(
  lines: TaxLine[],
  policy: TaxPolicyConfig
): TaxComputation {
  const lineResult: TaxLineComputation[] = []
  let vatableMinor = 0
  let vatMinor = 0
  let ewtMinor = 0

  for (const line of lines) {
    const taxable = !line.vatExempt && line.amountMinor > 0
    const lineVat = taxable ? pctBps(line.amountMinor, policy.vatRateBps) : 0
    const lineEwt = pctBps(line.amountMinor, policy.ewtRatesBps[line.class])

    vatableMinor += taxable ? line.amountMinor : 0
    vatMinor += lineVat
    ewtMinor += lineEwt

    lineResult.push({
      amountMinor: line.amountMinor,
      vatMinor,
      ewtMinor,
    })
  }

  const grossMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0)
  return {
    policyVersion: policy.version ?? null,
    grossMinor,
    vatableMinor,
    vatMinor,
    ewtMinor,
    netPayableMinor: grossMinor + vatMinor - ewtMinor,
    lines: lineResult,
  }
}

/** The Philippine default policy (retrievable as policy data in §8.4). */
export const PH_DEFAULT_POLICY: TaxPolicyConfig = {
  vatRateBps: 1200,
  ewtRatesBps: {
    goods: 100, // 1%
    services: 200, // 2%
    professional: 500, // 5% top-bracket professional
    rental: 500, // 5%
    other: 0,
  },
  version: "ph-v1",
}

/**
 * Normalize a raw policy config (from a database Policy row) into a strict
 * TaxPolicyConfig, filling in PH defaults for any missing rate so an older or
 * partial policy degrades gracefully.
 */
export function normalizeTaxPolicy(raw: unknown): TaxPolicyConfig {
  const input = (
    typeof raw === "object" && raw !== null ? raw : {}
  ) as Partial<TaxPolicyConfig>
  const vatRateBps = normalizeInt(input.vatRateBps, 1200)
  const ewtRatesBps: TaxPolicyConfig["ewtRatesBps"] = {
    ...PH_DEFAULT_POLICY.ewtRatesBps,
    ...(input.ewtRatesBps ?? {}),
  }
  return {
    vatRateBps,
    ewtRatesBps,
    version: input.version ?? undefined,
  }
}

function normalizeInt(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
