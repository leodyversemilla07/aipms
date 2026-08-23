"use client"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useEffect, useState } from "react"
import { minorToPhp } from "@/lib/money"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type SupplierRow = {
  vendorId: string
  name: string
  taxId: string | null
  invoiceCount: number
  baseAmountMinor: number
  taxWithheldMinor: number
}

type CertificateLine = {
  invoiceId: string
  number: string
  receivedAt: string
  baseAmountMinor: number
  ewtMinor: number
  taxPolicyVersion: string | null
}

type PeriodRow = {
  period: string
  taxWithheldMinor: number
  invoiceCount: number
}

/**
 * §8.4 — BIR statutory withholding reports, derived deterministically from
 * stored invoices. 1601-E aggregates the month per supplier; expanding a row
 * renders the supplier's Form 2307 certificate lines.
 */
export function BirReports() {
  const trpc = useTRPC()
  const [period, setPeriod] = useState("")

  const periods = useQuery(trpc.bir.periods.queryOptions({}))
  const periodRows = (periods.data?.rows ?? []) as unknown as PeriodRow[]

  // Default to the most recent period once loaded.
  useEffect(() => {
    if (!period && periodRows[0]) setPeriod(periodRows[0].period)
  }, [period, periodRows])

  const remittance = useQuery({
    ...trpc.bir.remittance.queryOptions({ period }),
    enabled: !!period,
  })
  const report = remittance.data as
    | {
        suppliers: SupplierRow[]
        totals: {
          invoiceCount: number
          baseAmountMinor: number
          taxWithheldMinor: number
        }
      }
    | undefined

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          BIR withholding (2307 / 1601-E)
        </h2>
        <Select
          value={period}
          onValueChange={(value) => setPeriod(value ?? "")}
        >
          <SelectTrigger className="w-40" aria-label="Period">
            <SelectValue placeholder="Period…" />
          </SelectTrigger>
          <SelectContent>
            {periodRows.map((p) => (
              <SelectItem key={p.period} value={p.period}>
                {p.period} ({p.invoiceCount})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!period ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          {periods.isPending ? "Loading periods…" : "No withholding data yet."}
        </p>
      ) : remittance.isPending ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          Computing 1601-E…
        </p>
      ) : !report || report.suppliers.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No creditable withholding recorded for {period}.
        </p>
      ) : (
        <>
          <table className="w-full rounded-lg border bg-card text-sm">
            <thead>
              <tr className="border-b text-muted-foreground text-xs uppercase">
                <th className="px-3 py-2 text-left">Supplier</th>
                <th className="px-3 py-2 text-right">Invoices</th>
                <th className="px-3 py-2 text-right">Base (net of VAT)</th>
                <th className="px-3 py-2 text-right">EWT withheld</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.suppliers.map((s) => (
                <SupplierItem key={s.vendorId} row={s} period={period} />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-medium">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">
                  {report.totals.invoiceCount}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {minorToPhp(report.totals.baseAmountMinor)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {minorToPhp(report.totals.taxWithheldMinor)}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          <p className="text-muted-foreground text-xs">
            Figures derive from stored invoices; each line cites the tax policy
            version it was computed under.
          </p>
        </>
      )}
    </section>
  )
}

function SupplierItem({ row, period }: { row: SupplierRow; period: string }) {
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)

  const certificate = useQuery({
    ...trpc.bir.certificate.queryOptions({ vendorId: row.vendorId, period }),
    enabled: open,
  })
  const cert = certificate.data as
    | {
        vendor: { name: string; taxId: string | null }
        lines: CertificateLine[]
      }
    | undefined

  return (
    <>
      <tr>
        <td className="px-3 py-2">
          <span className="font-medium">{row.name}</span>
          <span className="block text-muted-foreground text-xs">
            TIN {row.taxId ?? "—"}
          </span>
        </td>
        <td className="px-3 py-2 text-right">{row.invoiceCount}</td>
        <td className="px-3 py-2 text-right font-mono">
          {minorToPhp(row.baseAmountMinor)}
        </td>
        <td className="px-3 py-2 text-right font-mono">
          {minorToPhp(row.taxWithheldMinor)}
        </td>
        <td className="px-3 py-2 text-right">
          <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide 2307" : "Form 2307"}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5} className="bg-muted/30 px-3 pb-3">
            {certificate.isPending ? (
              <p className="py-2 text-muted-foreground text-xs">
                Loading certificate…
              </p>
            ) : cert && cert.lines.length > 0 ? (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 text-left">Invoice</th>
                    <th className="py-1 text-left">Received</th>
                    <th className="py-1 text-right">Base</th>
                    <th className="py-1 text-right">EWT</th>
                    <th className="py-1 text-left">Tax policy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cert.lines.map((l) => (
                    <tr key={l.invoiceId}>
                      <td className="py-1">{l.number}</td>
                      <td className="py-1">{fmtTime(l.receivedAt)}</td>
                      <td className="py-1 text-right font-mono">
                        {minorToPhp(l.baseAmountMinor)}
                      </td>
                      <td className="py-1 text-right font-mono">
                        {minorToPhp(l.ewtMinor)}
                      </td>
                      <td className="py-1 text-muted-foreground">
                        {l.taxPolicyVersion ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="py-2 text-muted-foreground text-xs">
                No withheld invoices for this supplier in {period}.
              </p>
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}
