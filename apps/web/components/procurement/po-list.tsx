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

type SignatureView = {
  signed: boolean
  configured: boolean
  keyId?: string
  signerId?: string
  signatureValid?: boolean
  documentUnchanged?: boolean
}

const PO_STATUS: Record<string, string> = {
  draft: "Draft",
  issued: "Issued",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
}

/**
 * §9 — purchase orders after issue: expanded line detail, confirm (vendor
 * acceptance), a two-step-confirmed §10.1 cancellation request (routes a
 * human gate into the exception queue), and §16.3 qualified signatures.
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
            <PoRowItem
              key={po.id}
              po={po}
              expanded={!!expanded[po.id]}
              onToggle={() =>
                setExpanded((prev) => ({ ...prev, [po.id]: !prev[po.id] }))
              }
              confirmPending={confirm.isPending}
              cancelPending={cancel.isPending}
              onConfirm={() =>
                confirm
                  .mutateAsync({
                    id: po.id,
                    idempotencyKey: `web-po-confirm-${po.id}`,
                  })
                  .then(refresh)
              }
              onCancel={() =>
                cancel
                  .mutateAsync({
                    id: po.id,
                    idempotencyKey: `web-po-cancel-${po.id}`,
                    reason: "Cancelled from procurement desk",
                  })
                  .then(refresh)
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function PoRowItem({
  po,
  expanded,
  onToggle,
  confirmPending,
  cancelPending,
  onConfirm,
  onCancel,
}: {
  po: PoRow
  expanded: boolean
  onToggle: () => void
  confirmPending: boolean
  cancelPending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  // §16.3 — signature status is fetched lazily per PO (expanded rows only).
  const signature = useQuery({
    ...trpc.purchaseOrder.signature.queryOptions({ id: po.id }),
    enabled: expanded,
  })
  const sig = signature.data as unknown as SignatureView | undefined

  const sign = useMutation(
    trpc.purchaseOrder.sign.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: trpc.purchaseOrder.signature.queryKey(),
        }),
    })
  )

  return (
    <li className="rounded-lg border bg-card px-4 py-2 text-sm">
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
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "Hide lines" : "Lines"}
          </Button>
          <span className="font-mono text-muted-foreground text-xs">
            {minorToPhp(po.totalMinor)}
          </span>
          {sig?.signed ? (
            <span
              title={`key ${sig.keyId ?? "?"} · signer ${sig.signerId ?? "?"}`}
              className={
                sig.documentUnchanged && sig.signatureValid
                  ? "rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs"
                  : "rounded-full bg-destructive/10 px-2 py-0.5 text-destructive text-xs"
              }
            >
              {sig.documentUnchanged && sig.signatureValid
                ? "Signed ✓"
                : "Invalid ✕"}
            </span>
          ) : null}
          {(po.status === "issued" || po.status === "confirmed") &&
          !sig?.signed ? (
            <Button
              size="sm"
              variant="outline"
              disabled={sign.isPending}
              title={
                sig && !sig.configured
                  ? "Configure AIPMS_SIGNING_KEYS_DIR to enable signing"
                  : "Countersign with the instance certificate"
              }
              onClick={() => sign.mutate({ id: po.id })}
            >
              Sign
            </Button>
          ) : null}
          {po.status === "issued" ? (
            <>
              <Button size="sm" disabled={confirmPending} onClick={onConfirm}>
                Confirm
              </Button>
              <ConfirmButton
                message="Cancel PO?"
                disabled={cancelPending}
                onConfirm={onCancel}
              >
                Request cancel
              </ConfirmButton>
            </>
          ) : null}
        </div>
      </div>

      {expanded ? (
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
              <span className="font-mono">{minorToPhp(l.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
