"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import { useEffect, useState } from "react"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type ReqRow = {
  id: string
  requestNumber: string
  status: string
  costCenter: string
  lines: Array<{
    description: string
    quantity: number
    unit: string | null
    lineTotalMinor: number
  }>
}
type VendorRow = { id: string; name: string }
type QuoteRow = {
  vendorId: string
  status: "requested" | "received" | "accepted" | "rejected"
}

function rowTotal(req: ReqRow): number {
  return req.lines.reduce((sum, l) => sum + l.lineTotalMinor, 0)
}

function RequisitionCard({
  req,
  vendorRows,
}: {
  req: ReqRow
  vendorRows: VendorRow[]
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [vendorId, setVendorId] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const issue = useMutation(trpc.purchaseOrder.issue.mutationOptions())
  const quotes = useQuery(
    trpc.sourcing.list.queryOptions({ requisitionId: req.id })
  )
  const acceptedQuote = ((quotes.data ?? []) as QuoteRow[]).find(
    (quote) => quote.status === "accepted"
  )

  useEffect(() => {
    if (acceptedQuote) setVendorId(acceptedQuote.vendorId)
  }, [acceptedQuote])

  async function doIssue() {
    setNotice(null)
    setError(null)
    try {
      const res = await issue.mutateAsync({
        idempotencyKey: `web-po-${crypto.randomUUID()}`,
        requisitionId: req.id,
        vendorId,
      })
      queryClient.invalidateQueries(trpc.purchaseOrder.pathFilter())
      queryClient.invalidateQueries(trpc.approval.pathFilter())
      if (res.outcome === "ISSUED") {
        setNotice(
          `PO ${res.purchaseOrder.poNumber} issued — budget committed in the same transaction.`
        )
      } else {
        setNotice(
          "Vendor gate fired: an approval was added to the exception queue. Decide it there, then re-issue."
        )
      }
    } catch (e) {
      setError(`Could not issue PO: ${(e as Error).message}`)
    }
  }

  const total = rowTotal(req)

  return (
    <li className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-sm">{req.requestNumber}</span>
        <span className="font-mono text-sm">{minorToPhp(total)}</span>
      </div>
      <p className="text-muted-foreground text-xs">
        {req.costCenter} · {req.lines.length} line(s)
      </p>

      <div className="flex items-center gap-2">
        <NativeSelect
          value={vendorId}
          disabled={Boolean(acceptedQuote)}
          onChange={(event) => setVendorId(event.target.value)}
        >
          <NativeSelectOption value="">Vendor…</NativeSelectOption>
          {vendorRows.map((vendor) => (
            <NativeSelectOption key={vendor.id} value={vendor.id}>
              {vendor.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          size="sm"
          disabled={!vendorId || issue.isPending}
          onClick={doIssue}
        >
          {issue.isPending ? "Issuing…" : "Issue PO"}
        </Button>
      </div>

      {acceptedQuote ? (
        <p className="text-muted-foreground text-xs">
          Vendor locked to the accepted sourcing award.
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </li>
  )
}

/**
 * §9 — issue a PO from an approved requisition. The API commits budget and
 * runs the vendor gate in one guarded transaction; a gated vendor routes an
 * approval to the exception queue instead of materialising the PO.
 */
export function IssuePo() {
  const trpc = useTRPC()
  const requisitions = useQuery(
    trpc.requisition.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const vendors = useQuery(
    trpc.vendor.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (requisitions.data?.rows ?? []) as ReqRow[]
  const vendorRows = (vendors.data?.rows ?? []) as VendorRow[]
  const approved = rows.filter((r) => r.status === "approved")

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Issue PO
        </h2>
        <span className="text-muted-foreground text-xs">
          {approved.length} approved
        </span>
      </div>

      {approved.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No approved requisitions ready for sourcing. Raise and approve one on
          the supervisory desk first.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {approved.map((req) => (
            <RequisitionCard key={req.id} req={req} vendorRows={vendorRows} />
          ))}
        </ul>
      )}
    </section>
  )
}
