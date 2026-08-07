"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type PoRow = {
  id: string
  poNumber: string
  status: string
  vendorId: string
  totalMinor: number
}

const PO_STATUS: Record<string, string> = {
  draft: "Draft",
  issued: "Issued",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
}

/**
 * §9 — purchase orders after issue: confirm (vendor acceptance) and request
 * cancellation (routes a §10.1 human gate into the exception queue).
 */
export function PoList() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

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
              className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium">{po.poNumber}</span>
                <span className="text-muted-foreground text-xs">
                  {PO_STATUS[po.status] ?? po.status} · vendor{" "}
                  {po.vendorId.slice(0, 8)}
                </span>
              </div>
              <div className="flex items-center gap-3">
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={cancel.isPending}
                      onClick={() =>
                        cancel
                          .mutateAsync({
                            id: po.id,
                            idempotencyKey: `web-po-cancel-${po.id}`,
                            reason: "Cancelled from procurement desk",
                          })
                          .then(() => {
                            refresh()
                          })
                      }
                    >
                      Request cancel
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
