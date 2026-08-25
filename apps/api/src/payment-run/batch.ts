import { createHash } from 'node:crypto'

/**
 * §8.6 payment batch file — normalized PESONet hand-off construction.
 *
 * v1 hands finance an approved/executed run as an importable batch: one
 * credit instruction per supplier line, beneficiary details copied from the
 * vendor master's verified bank account. Like the §8.5 journal export, this
 * is an anti-corruption boundary: banks/portal formats differ per instance,
 * so the normalized manifest + flat CSV is the stable product; mapping into
 * the org's exact bank template rides on top of it.
 *
 * Determinism: the manifest is derived only from stored run data (net amounts
 * were computed at compose time by PaymentRunService — never recomputed), and
 * the sha256 over the canonical JSON is idempotency + tamper-evidence.
 * Regenerating an unchanged run yields byte-identical output.
 */

export const BATCH_VERSION = 1

export interface BatchBeneficiary {
  bank: string
  accountNumber: string
  holder: string
}

/** Normalize the two bankAccount shapes used across the system. */
export function parseBeneficiary(raw: unknown): BatchBeneficiary | null {
  if (typeof raw !== 'object' || raw === null) return null
  const account = raw as Record<string, unknown>
  const bank = typeof account.bank === 'string' ? account.bank.trim() : ''
  const number =
    typeof account.accountNumber === 'string'
      ? account.accountNumber.trim()
      : typeof account.accountNo === 'string'
        ? account.accountNo.trim()
        : ''
  const holder = typeof account.holder === 'string' ? account.holder.trim() : ''
  if (!bank || !number || !holder) return null
  return { bank, accountNumber: number, holder }
}

export interface BatchLineInput {
  lineId: string
  invoiceId: string
  invoiceNumber: string
  vendorId: string
  vendorName: string
  vendorTaxId: string | null
  /** Net payable frozen at compose time (gross + VAT − EWT). */
  netMinor: number
  currencyCode: string
  bankAccount: unknown
}

export interface BatchLine {
  lineId: string
  invoiceId: string
  invoiceNumber: string
  vendorName: string
  vendorTaxId: string | null
  beneficiary: BatchBeneficiary
  amountMinor: number
  currencyCode: string
  memo: string
}

export interface BatchManifest {
  batchVersion: number
  kind: 'payment_batch'
  rail: 'pesonet'
  runNumber: string
  executedAt: string
  currencyCode: string
  totalMinor: number
  lineCount: number
  credits: BatchLine[]
}

export interface BuiltBatch {
  manifest: BatchManifest
  json: string
  csv: string
  sha256: string
}

function canonicalBatchJson(manifest: BatchManifest): string {
  return JSON.stringify(manifest)
}

function hash(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

const CSV_HEADERS = [
  'lineId',
  'invoiceNumber',
  'vendorName',
  'beneficiaryBank',
  'beneficiaryAccountNumber',
  'beneficiaryHolder',
  'amountMinor',
  'currencyCode',
  'memo',
] as const

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function batchToCsv(manifest: BatchManifest): string {
  const rows: string[] = [
    `# run=${manifest.runNumber} executedAt=${manifest.executedAt} total=${manifest.totalMinor} ${manifest.currencyCode}`,
    [...CSV_HEADERS].join(','),
  ]
  for (const c of manifest.credits) {
    rows.push(
      [
        c.lineId,
        c.invoiceNumber,
        c.vendorName,
        c.beneficiary.bank,
        c.beneficiary.accountNumber,
        c.beneficiary.holder,
        String(c.amountMinor),
        c.currencyCode,
        c.memo,
      ]
        .map((cell) => csvEscape(cell))
        .join(','),
    )
  }
  return `${rows.join('\n')}\n`
}

/**
 * Build the batch for one approved/executed run. Lines are ordered by
 * invoice number (then line id) so regeneration order never drifts. Throws
 * a readable error listing every unusable beneficiary rather than producing
 * a partial batch — a payment instruction set is all-or-nothing (§8.6).
 */
export function buildPaymentBatch(input: {
  runNumber: string
  executedAt: Date
  currencyCode: string
  totalMinor: number
  lines: BatchLineInput[]
}): BuiltBatch {
  const errors = input.lines
    .filter((line) => parseBeneficiary(line.bankAccount) === null)
    .map(
      (line) =>
        `${line.invoiceNumber} (${line.vendorName}): no verified beneficiary account`,
    )
  if (errors.length > 0) {
    throw new Error(`Unusable beneficiaries: ${errors.join('; ')}`)
  }

  const sorted = [...input.lines].sort(
    (a, b) =>
      a.invoiceNumber.localeCompare(b.invoiceNumber) ||
      a.lineId.localeCompare(b.lineId),
  )

  const sum = input.lines.reduce((acc, line) => acc + line.netMinor, 0)
  if (sum !== input.totalMinor) {
    throw new Error(
      `Batch does not balance: Σ lines ${sum} ≠ run total ${input.totalMinor}`,
    )
  }

  const manifest: BatchManifest = {
    batchVersion: BATCH_VERSION,
    kind: 'payment_batch',
    rail: 'pesonet',
    runNumber: input.runNumber,
    executedAt: input.executedAt.toISOString(),
    currencyCode: input.currencyCode,
    totalMinor: input.totalMinor,
    lineCount: input.lines.length,
    credits: sorted.map((line) => ({
      lineId: line.lineId,
      invoiceId: line.invoiceId,
      invoiceNumber: line.invoiceNumber,
      vendorName: line.vendorName,
      vendorTaxId: line.vendorTaxId,
      beneficiary: parseBeneficiary(line.bankAccount) as BatchBeneficiary,
      amountMinor: line.netMinor,
      currencyCode: line.currencyCode,
      memo: `Payment ${line.invoiceNumber} ${line.vendorName}`,
    })),
  }

  const json = canonicalBatchJson(manifest)
  return { manifest, json, csv: batchToCsv(manifest), sha256: hash(json) }
}
