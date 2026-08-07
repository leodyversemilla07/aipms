"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

const KIND_LABEL: Record<string, string> = {
  threshold: "Threshold exceeded",
  budgetOverride: "Budget override",
  vendorGate: "Vendor gate",
  policyGate: "Policy gate",
  poCancellation: "PO cancellation",
}

/**
 * Shape of a pending-approval row as consumed by this view. The router returns
 * richer Prisma rows; we only need the fields rendered here, so we cast to
 * avoid dragging the whole JSON-typed model (incl. recursive citations) into
 * the component type.
 */
type QueueApprovalRow = {
  id: string
  kind: string
  gateOutcome: string
  evidence: string | null
  citations?: Array<string> | null
  createdAt: string
  requisition: {
    lines: Array<{
      description: string
      quantity: number
      unitPriceMinor: number
    }>
  } | null
}

function lineSummary(
  lines: Array<{
    description: string
    quantity: number
    unitPriceMinor: number
  }>
): string {
  if (lines.length === 0) return ""
  const total = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0)
  const first = lines[0]?.description ?? ""
  const suffix = lines.length > 1 ? ` +${lines.length - 1} more` : ""
  return `${first}${suffix} — ${minorToPhp(total)}`
}

/**
 * §10.2 exception queue — approvals that need a human verdict. The API is the
 * source of truth; this view only renders pending rows and issues decide calls.
 */
export function ExceptionQueue() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const pending = useQuery(trpc.approval.pendingList.queryOptions())

  const decide = useMutation(
    trpc.approval.decide.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries(trpc.approval.pathFilter())
        queryClient.invalidateQueries(trpc.requisition.pathFilter())
      },
    })
  )

  if (pending.isPending)
    return <p className="text-muted-foreground text-sm">loading queue…</p>
  if (pending.isError) {
    return (
      <p className="text-destructive text-sm">
        Could not load the approval queue: {pending.error.message}
      </p>
    )
  }
  const rows = (pending.data ?? []) as unknown as QueueApprovalRow[]

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Exception queue
        </h2>
        <span className="text-muted-foreground text-xs">
          {rows.length} pending
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          Queue is clear — no approvals need a human verdict.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {KIND_LABEL[a.kind] ?? a.kind}
                </span>
                <span className="text-muted-foreground text-xs">
                  {a.createdAt.toLocaleString()}
                </span>
              </div>

              {a.requisition ? (
                <p className="font-medium text-sm">
                  {lineSummary(a.requisition.lines)}
                </p>
              ) : null}

              <p className="text-muted-foreground text-xs">
                Gate outcome: <span className="font-mono">{a.gateOutcome}</span>
                {a.evidence ? ` · evidence: ${a.evidence}` : ""}
              </p>

              {a.citations && a.citations.length > 0 ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  cites: {a.citations.join(", ")}
                </p>
              ) : null}

              <div className="mt-1 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="default"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      id: a.id,
                      idempotencyKey: `web-approve-${a.id}`,
                      verdict: "approve",
                    })
                  }
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending}
                  onClick={() =>
                    decide.mutate({
                      id: a.id,
                      idempotencyKey: `web-reject-${a.id}`,
                      verdict: "reject",
                      evidence: "Rejected from supervisory desk",
                    })
                  }
                >
                  Reject
                </Button>
                {decide.isPending && (
                  <span className={cn("text-muted-foreground text-xs")}>
                    deciding…
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
