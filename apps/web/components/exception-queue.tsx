"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useState } from "react"
import { minorToPhp } from "@/lib/money"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

const KIND_LABEL: Record<string, string> = {
  threshold: "Threshold exceeded",
  budgetOverride: "Budget override",
  vendorGate: "Vendor gate",
  policyGate: "Policy gate",
  poCancellation: "PO cancellation",
}

/** Normalize JSON citations before rendering them. */
type ApprovalOutput = {
  id: string
  kind: string
  gateOutcome: string
  evidence: string | null
  citations: unknown
  createdAt: string | Date
  requisition: {
    lines: Array<{
      description: string
      quantity: number
      unitPriceMinor: number
    }>
  } | null
}
type QueueApprovalRow = Omit<ApprovalOutput, "citations"> & {
  citations: string[]
}

function normalizeApproval(row: ApprovalOutput): QueueApprovalRow {
  return {
    ...row,
    citations: Array.isArray(row.citations)
      ? row.citations.filter((c): c is string => typeof c === "string")
      : [],
  }
}

function lineSummary(
  lines: NonNullable<QueueApprovalRow["requisition"]>["lines"]
) {
  if (lines.length === 0) return "No requisition lines"
  const total = lines.reduce(
    (sum, line) => sum + line.quantity * line.unitPriceMinor,
    0
  )
  const suffix = lines.length > 1 ? ` +${lines.length - 1} more` : ""
  return `${lines[0]?.description ?? "Requisition"}${suffix} · ${minorToPhp(total)}`
}

/** Human review requires an explicit confirmation; the API remains the source of truth. */
export function ExceptionQueue() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [review, setReview] = useState<QueueApprovalRow | null>(null)
  const pending = useQuery(trpc.approval.pendingList.queryOptions())
  const decide = useMutation(
    trpc.approval.decide.mutationOptions({
      onSuccess: () => {
        setReview(null)
        queryClient.invalidateQueries(trpc.approval.pathFilter())
        queryClient.invalidateQueries(trpc.requisition.pathFilter())
      },
    })
  )
  const pendingRows = pending.data as ApprovalOutput[] | undefined
  const rows: QueueApprovalRow[] = (pendingRows ?? []).map(normalizeApproval)

  function submit(verdict: "approve" | "reject") {
    if (!review || decide.isPending) return
    decide.mutate({
      id: review.id,
      idempotencyKey: `web-${verdict}-${review.id}`,
      verdict,
      ...(verdict === "reject"
        ? { evidence: "Rejected from supervisory desk" }
        : {}),
    })
  }

  return (
    <section aria-labelledby="queue-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="queue-title" className="font-heading font-medium">
          Approval queue
        </h3>
        {pending.data ? (
          <Badge variant="outline">{rows.length} pending</Badge>
        ) : null}
      </div>
      {pending.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : pending.isError ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load the approval queue: {pending.error.message}
        </p>
      ) : rows.length === 0 ? (
        <Empty className="border py-6">
          <EmptyHeader>
            <EmptyTitle>All caught up</EmptyTitle>
            <EmptyDescription>
              No approvals need a human decision right now.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((item) => (
            <li key={item.id}>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>{KIND_LABEL[item.kind] ?? item.kind}</CardTitle>
                  <CardAction>
                    <Badge variant="secondary">Pending</Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="font-medium">
                    {item.requisition
                      ? lineSummary(item.requisition.lines)
                      : "Approval requires review"}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {fmtTime(item.createdAt)} · Gate outcome: {item.gateOutcome}
                    {item.evidence ? ` · ${item.evidence}` : ""}
                  </p>
                </CardContent>
                <CardFooter>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReview(item)}
                  >
                    Review decision
                  </Button>
                </CardFooter>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !decide.isPending) setReview(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review approval decision</AlertDialogTitle>
            <AlertDialogDescription>
              Check the request, policy evidence and amount before deciding.
              Your decision will be recorded in the audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {review ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">
                {review.requisition
                  ? lineSummary(review.requisition.lines)
                  : (KIND_LABEL[review.kind] ?? review.kind)}
              </p>
              <p>Gate: {review.gateOutcome}</p>
              {review.evidence ? <p>Evidence: {review.evidence}</p> : null}
              {review.citations?.length ? (
                <p className="break-words text-muted-foreground text-xs">
                  Citations: {review.citations.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
          {decide.isError ? (
            <p role="alert" className="text-destructive text-sm">
              Decision failed: {decide.error.message}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={decide.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={decide.isPending}
              onClick={() => submit("reject")}
            >
              Reject
            </Button>
            <Button
              disabled={decide.isPending}
              onClick={() => submit("approve")}
            >
              Approve
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
