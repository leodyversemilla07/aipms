"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type PoLine = {
  lineNo: number
  sku: string | null
  description: string
  quantity: number
  unit: string | null
  lineTotalMinor: number
}

type PoRow = {
  id: string
  poNumber: string
  status: string
  vendorId: string
  totalMinor: number
  lines: PoLine[]
}

const PO_STATUS: Record<string, string> = {
  draft: "Draft",
  issued: "Issued",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
}

/**
 * §9 — purchase orders after issue: expanded line detail, confirm (vendor
 * acceptance), and a two-step-confirmed §10.1 cancellation request (routes a
 * human gate into the exception queue).
 */
export function PoList() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const pos = useQuery(
    trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (pos.data?.rows ?? []) as unknown as PoRow[]

  const confirm = useMutation(trpc.purchaseOrder.confirm.mutationOptions())
  const cancel = useMutation(
    trpc.purchaseOrder.requestCancellation.mutationOptions()
  )

  function refresh() {
    queryClient.invalidateQueries(trpc.purchaseOrder.pathFilter())
    queryClient.invalidateQueries(trpc.approval.pathFilter())
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Purchase orders
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No POs yet — issue one from an approved requisition above.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((po) => (
            <li
              key={po.id}
              className="rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-medium">{po.poNumber}</span>
                  <span className="text-muted-foreground text-xs">
                    {PO_STATUS[po.status] ?? po.status} · vendor{" "}
                    {po.vendorId.slice(0, 8)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={!!expanded[po.id]}
                    onClick={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [po.id]: !prev[po.id],
                      }))
                    }
                  >
                    {expanded[po.id] ? "Hide lines" : "Lines"}
                  </Button>
                  <span className="font-mono text-muted-foreground text-xs">
                    {minorToPhp(po.totalMinor)}
                  </span>
                  {po.status === "issued" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={confirm.isPending}
                        onClick={() =>
                          confirm
                            .mutateAsync({
                              id: po.id,
                              idempotencyKey: `web-po-confirm-${po.id}`,
                            })
                            .then(refresh)
                        }
                      >
                        Confirm
                      </Button>
                      <ConfirmButton
                        message="Cancel PO?"
                        disabled={cancel.isPending}
                        onConfirm={() =>
                          cancel
                            .mutateAsync({
                              id: po.id,
                              idempotencyKey: `web-po-cancel-${po.id}`,
                              reason: "Cancelled from procurement desk",
                            })
                            .then(refresh)
                        }
                      >
                        Request cancel
                      </ConfirmButton>
                    </>
                  ) : null}
                </div>
              </div>

              {expanded[po.id] ? (
                <ul className="mt-2 flex flex-col divide-y divide-border rounded-lg border bg-muted/30">
                  {po.lines.map((l) => (
                    <li
                      key={l.lineNo}
                      className="grid grid-cols-[3rem_1fr_auto] items-center gap-2 px-3 py-1 text-xs"
                    >
                      <span className="font-mono text-muted-foreground">
                        #{l.lineNo}
                      </span>
                      <span>
                        {l.sku ? `${l.sku} — ` : ""}
                        {l.description}
                        <span className="text-muted-foreground">
                          {" "}
                          × {l.quantity} {l.unit ?? ""}
                        </span>
                      </span>
                      <span className="font-mono">
                        {minorToPhp(l.lineTotalMinor)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
