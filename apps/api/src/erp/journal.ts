import { createHash } from 'node:crypto'

/**
 * §8.5 governed journal export — pure posting-manifest construction.
 *
 * aipms is the author of record for procurement transaction state; the ERP
 * owns final posting. The manifest is the anti-corruption boundary: a
 * normalized, balanced payment-journal derived deterministically from stored
 * invoices (§8.4 tax split already applied at registration — never recomputed
 * here). The sha256 over the canonical JSON is both idempotency (re-export of
 * unchanged data yields the same hash) and tamper-evidence.
 *
 * Per invoice the journal is balanced by construction:
 *   DR Accounts Payable      (gross + VAT)
 *   CR EWT Withholding Payable (EWT, when withheld)
 *   CR Cash Clearing         (net = gross + VAT − EWT)
 */

export const MANIFEST_VERSION = 1

/** Instance-configurable chart mapping (v1 default; policy seam later). */
export const DEFAULT_ACCOUNTS = {
  accountsPayable: '2010',
  ewtWithholdingPayable: '2020',
  cashClearing: '1010',
} as const

export interface ManifestInvoice {
  invoiceId: string
  invoiceNumber: string
  vendorName: string
  vendorTaxId: string | null
  /** VAT-exclusive gross (§8.4 base). */
  amountMinor: number
  vatMinor: number
  ewtMinor: number
}

export interface ManifestInput {
  runNumber: string
  executedAt: Date
  currencyCode: string
  invoices: ManifestInvoice[]
}

export interface JournalEntry {
  invoiceId: string
  invoiceNumber: string
  vendorName: string
  vendorTaxId: string | null
  account: string
  side: 'debit' | 'credit'
  amountMinor: number
  currencyCode: string
  memo: string
}

export interface JournalManifest {
  manifestVersion: number
  kind: 'payment_journal'
  runNumber: string
  executedAt: string
  currencyCode: string
  totalMinor: number
  entries: JournalEntry[]
}

/** Net cash moved for one invoice (what the buyer funds). */
function netMinor(inv: ManifestInvoice): number {
  return inv.amountMinor + inv.vatMinor - inv.ewtMinor
}

export function buildJournalManifest(input: ManifestInput): JournalManifest {
  const entries: JournalEntry[] = []
  for (const inv of input.invoices) {
    const base = {
      invoiceId: inv.invoiceId,
      invoiceNumber: inv.invoiceNumber,
      vendorName: inv.vendorName,
      vendorTaxId: inv.vendorTaxId,
    }
    entries.push({
      ...base,
      account: DEFAULT_ACCOUNTS.accountsPayable,
      side: 'debit',
      amountMinor: inv.amountMinor + inv.vatMinor,
      currencyCode: input.currencyCode,
      memo: `AP ${inv.invoiceNumber} ${inv.vendorName}`,
    })
    if (inv.ewtMinor > 0) {
      entries.push({
        ...base,
        account: DEFAULT_ACCOUNTS.ewtWithholdingPayable,
        side: 'credit',
        amountMinor: inv.ewtMinor,
        currencyCode: input.currencyCode,
        memo: `EWT withheld ${inv.invoiceNumber}`,
      })
    }
    entries.push({
      ...base,
      account: DEFAULT_ACCOUNTS.cashClearing,
      side: 'credit',
      amountMinor: netMinor(inv),
      currencyCode: input.currencyCode,
      memo: `Payment ${inv.invoiceNumber}`,
    })
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    kind: 'payment_journal',
    runNumber: input.runNumber,
    executedAt: input.executedAt.toISOString(),
    currencyCode: input.currencyCode,
    totalMinor: input.invoices.reduce((s, inv) => s + netMinor(inv), 0),
    entries,
  }
}

/** Deterministic canonical JSON — stable key order, no whitespace. */
export function canonicalManifestJson(manifest: JournalManifest): string {
  return JSON.stringify(manifest)
}

export function manifestHash(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

/** Verify the journal balances: Σ debits == Σ credits (totalMinor is net cash). */
export function verifyBalanced(manifest: JournalManifest): {
  balanced: boolean
  debitsMinor: number
  creditsMinor: number
} {
  let debits = 0
  let credits = 0
  for (const e of manifest.entries) {
    if (e.side === 'debit') debits += e.amountMinor
    else credits += e.amountMinor
  }
  return {
    balanced: debits === credits && credits > 0,
    debitsMinor: debits,
    creditsMinor: credits,
  }
}

const CSV_HEADERS = [
  'invoiceId',
  'invoiceNumber',
  'vendorName',
  'vendorTaxId',
  'account',
  'side',
  'amountMinor',
  'currencyCode',
  'memo',
] as const

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Flat journal-import CSV any ERP can consume (§8.5 v1 anchor format). */
export function manifestToCsv(manifest: JournalManifest): string {
  const rows: string[] = [
    `# run=${manifest.runNumber} executedAt=${manifest.executedAt} total=${manifest.totalMinor}`,
    [...CSV_HEADERS].join(','),
  ]
  for (const e of manifest.entries) {
    rows.push(
      [
        e.invoiceId,
        e.invoiceNumber,
        e.vendorName,
        e.vendorTaxId ?? '',
        e.account,
        e.side,
        String(e.amountMinor),
        e.currencyCode,
        e.memo,
      ]
        .map((cell) => csvEscape(cell))
        .join(','),
    )
  }
  return `${rows.join('\n')}\n`
}
