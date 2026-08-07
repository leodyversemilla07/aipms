"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
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

function rowTotal(req: ReqRow): number {
  return req.lines.reduce((sum, l) => sum + l.lineTotalMinor, 0)
}

function RequisitionCard({
  req,
  vendorRows,
}: {
  req: ReqRow
  vendorRows: Array<{ id: string; name: string }>
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [vendorId, setVendorId] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const issue = useMutation(trpc.purchaseOrder.issue.mutationOptions())

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
        <select
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className="h-9 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Vendor…</option>
          {vendorRows.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!vendorId || issue.isPending}
          onClick={doIssue}
        >
          {issue.isPending ? "Issuing…" : "Issue PO"}
        </Button>
      </div>

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
  const rows = (requisitions.data?.rows ?? []) as unknown as ReqRow[]
  const vendorRows = (vendors.data?.rows ?? []) as unknown as Array<{
    id: string
    name: string
  }>
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
