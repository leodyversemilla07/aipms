"use client"

import { useQuery } from "@tanstack/react-query"
import { INVOICE_STATUS, netMinor } from "@/lib/finance"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

/**
 * Recently received invoices with their derived tax fields (§8.4) and
 * match status.
 */
export function InvoiceList() {
  const trpc = useTRPC()
  const invoices = useQuery(trpc.invoice.list.queryOptions({}))

  if (invoices.isPending) {
    return <p className="text-muted-foreground text-sm">loading invoices…</p>
  }
  if (invoices.isError) {
    return (
      <p className="text-destructive text-sm">
        Could not load invoices: {invoices.error.message}
      </p>
    )
  }
  // Prisma payload rows recurse deeply; narrow to the fields rendered here.
  const rows = (invoices.data ?? []) as unknown as Array<{
    id: string
    number: string
    status: string
    poId: string | null
    amountMinor: number
    vatMinor: number
    ewtMinor: number
  }>

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Invoices
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No invoices registered yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((inv) => (
            <li
              key={inv.id}
              className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium">{inv.number}</span>
                <span className="text-muted-foreground text-xs">
                  {INVOICE_STATUS[inv.status] ?? inv.status}
                  {inv.poId ? " · has PO" : ""}
                </span>
              </div>
              <div className="flex items-center gap-4 font-mono text-muted-foreground text-xs">
                <span>gross {minorToPhp(inv.amountMinor)}</span>
                <span>VAT {minorToPhp(inv.vatMinor)}</span>
                <span>EWT {minorToPhp(inv.ewtMinor)}</span>
                <span className="text-foreground">
                  net {minorToPhp(netMinor(inv))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
