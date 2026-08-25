import { XMLParser } from 'fast-xml-parser'

/**
 * §8.2 structured e-invoicing — receive-side parsers for the two machine
 * channels the spec requires alongside email: BIR EIS JSON (RR 11-2025;
 * JSON is the EIS transmission format) and Peppol/EDI-flavored UBL 2.1 XML
 * (Peppol BIS Billing). Both reduce a supplier document to the same
 * normalized classification the intake queue expects, so structured
 * documents enter the pipeline pre-extracted — deterministic, no LLM.
 *
 * The BIR has not published an authoritative public schema; we accept the
 * documented core (EisUniqueId, IssueDtm, seller Tin + BranchCd, ItemList,
 * SalesAmt/NetSales) and treat unknown extras as opaque. Money arrives as
 * decimal pesos in both formats and is converted to integer minor units
 * here — the only place float→int conversion is allowed.
 */

export type StructuredChannel = 'EINVOICE_EIS' | 'PEPPOL_UBL'

export interface ClassifiedLine {
  description: string
  quantity: number | null
  unitPriceMinor: number | null
  amountMinor: number
}

export interface ClassifiedInvoice {
  docType: 'invoice'
  source: 'BIR_EIS' | 'PEPPOL_UBL'
  invoiceNumber: string | null
  issueDate: string | null // ISO date
  supplierName: string | null
  supplierTin: string | null
  currencyCode: string
  netAmountMinor: number
  taxAmountMinor: number
  grossAmountMinor: number
  lines: ClassifiedLine[]
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Decimal pesos → minor units (safe-integers only; half-up on the centavo). */
export function toMinor(pesos: number): number {
  if (!Number.isFinite(pesos)) {
    throw new Error(`Non-numeric amount: ${pesos}`)
  }
  // Correct binary-representation drift before rounding: 1.005 * 100 is
  // 100.49999999999999 in float64, but half-up on the true decimal is 101.
  // Precision-normalizing to 12 significant digits restores the intended
  // value without affecting safe-integer magnitudes (PHP centavos ≪ 1e12).
  const minor = Number((pesos * 100).toPrecision(12))
  if (!Number.isSafeInteger(Math.round(minor))) {
    throw new Error(`Amount out of range: ${pesos}`)
  }
  return Math.round(minor)
}

/** "20260131" → "2026-01-31"; passes ISO strings through; null otherwise. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 10)
}

// ── BIR EIS JSON ────────────────────────────────────────────────────────────

/**
 * Parse one BIR EIS e-invoice JSON object. Accepts either a single object or
 * an array wrapper (batch transmissions take element [0]).
 */
export function parseBirEisObject(input: unknown): ClassifiedInvoice {
  const doc = Array.isArray(input) ? first(input) : input
  const root = asRecord(doc)

  const itemListRaw = root.ItemList
  const items = Array.isArray(itemListRaw)
    ? itemListRaw
    : itemListRaw != null
      ? [itemListRaw]
      : []
  const lines: ClassifiedLine[] = items.map((rawItem) => {
    const item = asRecord(rawItem)
    const qty =
      typeof item.Qty === 'number'
        ? item.Qty
        : item.Quantity != null
          ? Number(item.Quantity)
          : null
    const unit =
      item.UnitPrice != null
        ? Number(item.UnitPrice)
        : item.UnitCost != null
          ? Number(item.UnitCost)
          : null
    const amount =
      item.GrossAmount != null
        ? Number(item.GrossAmount)
        : item.Amount != null
          ? Number(item.Amount)
          : item.SalesAmt != null
            ? Number(item.SalesAmt)
            : 0
    return {
      description:
        typeof item.Description === 'string'
          ? item.Description
          : typeof item.ItemCode === 'string'
            ? item.ItemCode
            : '(no description)',
      quantity: qty != null && Number.isFinite(qty) ? qty : null,
      unitPriceMinor:
        unit != null && Number.isFinite(unit) ? toMinor(unit) : null,
      amountMinor: toMinor(amount),
    }
  })

  const sales = root.SalesAmt != null ? Number(root.SalesAmt) : null
  const net = root.NetSales != null ? Number(root.NetSales) : sales
  const tax =
    root.TaxTotal != null
      ? Number(root.TaxTotal)
      : root.VatAmount != null
        ? Number(root.VatAmount)
        : 0
  if (net == null || !Number.isFinite(net)) {
    throw new Error('EIS document missing NetSales/SalesAmt')
  }

  const grossSource =
    root.GrossAmount != null
      ? Number(root.GrossAmount)
      : root.TotalSales != null
        ? Number(root.TotalSales)
        : null

  return {
    docType: 'invoice',
    source: 'BIR_EIS',
    invoiceNumber:
      typeof root.InvoiceNumber === 'string' ? root.InvoiceNumber : null,
    issueDate: normalizeDate(root.IssueDtm),
    supplierName: typeof root.SellerName === 'string' ? root.SellerName : null,
    supplierTin: typeof root.Tin === 'string' ? root.Tin : null,
    currencyCode: typeof root.Currency === 'string' ? root.Currency : 'PHP',
    netAmountMinor: toMinor(net),
    taxAmountMinor: Number.isFinite(tax) ? toMinor(tax) : 0,
    grossAmountMinor:
      grossSource != null && Number.isFinite(grossSource)
        ? toMinor(grossSource)
        : toMinor(net) + (Number.isFinite(tax) ? toMinor(tax) : 0),
    lines: lines.length > 0 ? lines : [],
  }
}

// ── Peppol / UBL 2.1 XML ────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true, // ubl:/cbc:/cac: prefixes vanish; tags match locally
  // Preserve raw text as-is: amounts are parsed explicitly via num(), and
  // leading-zero TINs must not become integers.
  parseTagValue: false,
})

const text = (value: unknown): string | null => {
  const v = first(value)
  if (v == null) return null
  if (typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const t = rec['#text']
    return typeof t === 'string' ? t : typeof t === 'number' ? String(t) : null
  }
  return String(v)
}

const num = (value: unknown): number | null => {
  const t = text(value)
  if (t == null) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function parseUblInvoice(xml: string): ClassifiedInvoice {
  let parsed: Record<string, unknown>
  try {
    parsed = asRecord(xmlParser.parse(xml))
  } catch {
    throw new Error('Malformed XML document')
  }
  const inv = asRecord(first(parsed.Invoice) ?? first(parsed.CreditNote))
  if (Object.keys(inv).length === 0) {
    throw new Error('Not a UBL Invoice/CreditNote document')
  }

  const supplierParty = asRecord(first(inv.AccountingSupplierParty) ?? {})
  const supplier = asRecord(asRecord(supplierParty.Party).PartyLegalEntity)
  const taxTotal = asRecord(inv.TaxTotal)
  const totals = asRecord(inv.LegalMonetaryTotal)

  const net = num(totals.TaxExclusiveAmount) ?? 0
  const tax = num(taxTotal.TaxAmount) ?? 0
  const gross =
    num(totals.PayableAmount) ?? num(totals.TaxInclusiveAmount) ?? net + tax

  const currency =
    text(
      (first(totals.PayableAmount) as Record<string, unknown> | undefined)?.[
        '@currencyID'
      ],
    ) ?? 'PHP'

  const lineList = inv.InvoiceLine
  const rawLines = Array.isArray(lineList)
    ? lineList
    : lineList != null
      ? [lineList]
      : []
  const lines: ClassifiedLine[] = rawLines.map((rawLine) => {
    const line = asRecord(rawLine)
    const item = asRecord(line.Item)
    return {
      description:
        text(item.Description) ?? text(item.Name) ?? '(no description)',
      quantity: num(line.InvoicedQuantity),
      unitPriceMinor: (() => {
        const priceAmount = num(
          line.Price != null ? asRecord(line.Price).PriceAmount : undefined,
        )
        return priceAmount != null ? toMinor(priceAmount) : null
      })(),
      amountMinor: toMinor(num(line.LineExtensionAmount) ?? 0),
    }
  })

  return {
    docType: 'invoice',
    source: 'PEPPOL_UBL',
    invoiceNumber: text(inv.ID),
    issueDate: normalizeDate(text(inv.IssueDate)),
    supplierName: text(supplier.RegistrationName),
    supplierTin: text(supplier.CompanyID),
    currencyCode: currency,
    netAmountMinor: toMinor(net),
    taxAmountMinor: toMinor(tax),
    grossAmountMinor: toMinor(gross),
    lines,
  }
}

// ── Channel entry point ─────────────────────────────────────────────────────

/**
 * Route one structured document by channel. Throws with a readable reason on
 * malformed payloads — the caller surfaces it into the intake exception path
 * rather than guessing (§7.4 fail visible).
 */
export function parseStructuredInvoice(
  channel: StructuredChannel,
  content: string,
): ClassifiedInvoice {
  const trimmed = content.trim()
  if (channel === 'EINVOICE_EIS') {
    try {
      return parseBirEisObject(JSON.parse(trimmed))
    } catch (error) {
      throw new Error(
        `Invalid BIR EIS JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return parseUblInvoice(trimmed)
}
