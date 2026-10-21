"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { PageControls } from "@/components/page-controls"
import { EmptyState } from "@/components/states/empty-state"
import { ErrorState } from "@/components/states/error-state"
import { PendingCard } from "@/components/states/pending-state"
import { INVOICE_STATUS, netMinor } from "@/lib/finance"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

/**
 * Recently received invoices with their derived tax fields (§8.4) and
 * match status.
 */
const PAGE_SIZE = 25

export function InvoiceList({
  status,
  heading,
}: {
  /** Restrict the list to one invoice status (§8.4 exception queue). */
  status?: "received" | "matched" | "exception" | "paid"
  /** Heading owned by the page; the panel renders its own when omitted. */
  heading?: ReactNode
}) {
  const trpc = useTRPC()
  const [page, setPage] = useState(1)
  const invoices = useQuery(
    trpc.invoice.page.queryOptions({ page, pageSize: PAGE_SIZE, status })
  )
  const total = invoices.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  useEffect(() => {
    if (invoices.data && page > totalPages) setPage(totalPages)
  }, [invoices.data, page, totalPages])

  if (invoices.isPending) {
    return <PendingCard label="Loading invoices" />
  }

  if (invoices.isError) {
    return (
      <ErrorState
        title="Failed to load invoices"
        message={invoices.error.message}
      />
    )
  }

  type InvoiceRow = {
    id: string
    number: string
    status: string
    poId: string | null
    amountMinor: number
    vatMinor: number
    ewtMinor: number
  }
  const rows = (invoices.data?.rows ?? []) as InvoiceRow[]

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        {heading === undefined ? (
          <h2
            id="invoices"
            className="scroll-mt-6 font-heading font-semibold text-xl tracking-tight"
          >
            Invoices
          </h2>
        ) : (
          heading
        )}
        <span className="text-muted-foreground text-xs">
          {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–
          {Math.min(page * PAGE_SIZE, total)} of {total}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No invoices registered yet."
          description="Register one from a received purchase order."
        />
      ) : (
        <Table className="w-full">
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">VAT</TableHead>
              <TableHead className="text-right">EWT</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>{inv.number}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {INVOICE_STATUS[inv.status] ?? inv.status}
                    {inv.poId ? " · PO" : ""}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {minorToPhp(inv.amountMinor)}
                </TableCell>
                <TableCell className="text-right">
                  {minorToPhp(inv.vatMinor)}
                </TableCell>
                <TableCell className="text-right">
                  {minorToPhp(inv.ewtMinor)}
                </TableCell>
                <TableCell className="text-right font-medium text-foreground">
                  {minorToPhp(netMinor(inv))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {total > PAGE_SIZE ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span role="status" className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </span>
          <PageControls
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </div>
      ) : null}
    </section>
  )
}
