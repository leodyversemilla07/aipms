/**
 * Finance desk helpers. Money stays in minor units (§8.4); net = gross +
 * VAT − EWT per the PH tax engine.
 */
export type InvoiceRow = {
  id: string
  number: string
  status: string
  amountMinor: number
  vatMinor: number
  ewtMinor: number
}
export type PaymentRunRow = {
  id: string
  runNumber: string
  status: string
  totalMinor: number
}
export type VendorRow = { id: string; name: string }

export const INVOICE_STATUS: Record<string, string> = {
  received: "Received",
  matched: "Matched",
  exception: "Exception",
  paid: "Paid",
}

export const RUN_STATUS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  executed: "Executed",
  reconciled: "Reconciled",
  voided: "Voided",
}

export const LINE_STATUS: Record<string, string> = {
  planned: "Planned",
  paid: "Paid",
  dishonored: "Dishonored",
  rejected: "Rejected",
}

/** net = gross + VAT − EWT */
export function netMinor(invoice: {
  amountMinor: number
  vatMinor: number
  ewtMinor: number
}): number {
  return invoice.amountMinor + invoice.vatMinor - invoice.ewtMinor
}
