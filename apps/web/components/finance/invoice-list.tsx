"use client"

import { useQuery } from "@tanstack/react-query"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
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
    // Show a loading skeleton instead of plain text.
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    )
  }

  if (invoices.isError) {
    // Use shadcn Alert for a richer error UI.
    return (
      <Alert variant="destructive">
        <AlertTitle>Failed to load invoices</AlertTitle>
        <AlertDescription>{invoices.error.message}</AlertDescription>
      </Alert>
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
    </section>
  )
}
