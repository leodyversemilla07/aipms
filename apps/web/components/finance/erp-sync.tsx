"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { minorToPhp } from "@/lib/money"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type ExportRow = {
  id: string
  runId: string
  runNumber: string
  manifestHash: string
  lineCount: number
  totalMinor: number
  currencyCode: string
  status: string
  externalRef: string | null
  rejectedReason: string | null
  acknowledgedAt: string | null
  exportedAt: string
}

/**
 * §8.5 — ERP bridge on the finance desk. Executed runs export once as a
 * governed journal (hash-verified); the ERP's acknowledgement settles the
 * export, and the reconciliation report surfaces publishing debt and
 * unacknowledged feeds instead of letting them drift silently.
 */
export function ErpSync() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [manifestFor, setManifestFor] = useState<ExportRow | null>(null)
  const [rejecting, setRejecting] = useState<ExportRow | null>(null)
  const [reason, setReason] = useState("")

  const exportsQuery = useQuery(
    trpc.erp.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (exportsQuery.data?.rows ?? []) as unknown as ExportRow[]

  const report = useQuery(trpc.erp.reconcileReport.queryOptions({}))

  const manifest = useQuery({
    ...trpc.erp.manifest.queryOptions({ id: manifestFor?.id ?? "" }),
    enabled: !!manifestFor,
  })

  const acknowledge = useMutation(trpc.erp.acknowledge.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.erp.pathFilter())
    queryClient.invalidateQueries({
      queryKey: trpc.erp.reconcileReport.queryKey(),
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          ERP sync (journal export §8.5)
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      {/* Reconciliation gate */}
      <div className="rounded-lg border bg-card px-4 py-3 text-xs">
        {report.isPending ? (
          <span className="text-muted-foreground">Reconciling…</span>
        ) : report.data ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <StatusChip
              label={
                report.data.clean ? "reconciled" : "divergence — see below"
              }
              tone={report.data.clean ? "ok" : "warn"}
            />
            <span className="text-muted-foreground">
              executed runs:{" "}
              <span className="font-mono">{report.data.executedRuns}</span>
            </span>
            <span className="text-muted-foreground">
              un-exported:{" "}
              <span className="font-mono">
                {report.data.missingExports.length}
              </span>
            </span>
            <span className="text-muted-foreground">
              awaiting ERP ack:{" "}
              <span className="font-mono">
                {report.data.awaitingAcknowledgement.length}
              </span>
            </span>
            <span className="text-muted-foreground">
              posted to ERP:{" "}
              <span className="font-mono">
                {minorToPhp(report.data.postedTotalMinor)}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No journal exports yet — execute a payment run, then export it from
          the runs list above.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((e) => (
            <li
              key={e.id}
              className="rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-medium">{e.runNumber}</span>
                  <span className="text-muted-foreground text-xs">
                    {e.lineCount} entries ·{" "}
                    <span className="font-mono">
                      {minorToPhp(e.totalMinor)}
                    </span>{" "}
                    · exported {fmtTime(e.exportedAt)}
                    {e.externalRef ? ` · ref ${e.externalRef}` : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusChip
                    label={e.status}
                    tone={
                      e.status === "posted"
                        ? "ok"
                        : e.status === "rejected"
                          ? "bad"
                          : "warn"
                    }
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setManifestFor(e)}
                  >
                    Journal
                  </Button>
                  {e.status === "exported" ? (
                    <>
                      <Button
                        size="sm"
                        disabled={acknowledge.isPending}
                        onClick={() =>
                          acknowledge
                            .mutateAsync({
                              exportId: e.id,
                              status: "posted",
                              externalRef: undefined,
                            })
                            .then(refresh)
                            .catch((err: Error) => setError(err.message))
                        }
                      >
                        Mark posted
                      </Button>
                      <ConfirmReject
                        pending={acknowledge.isPending}
                        reason={reason}
                        onReasonChange={setReason}
                        armed={rejecting?.id === e.id}
                        onArm={() => setRejecting(e)}
                        onCancel={() => setRejecting(null)}
                        onConfirm={() =>
                          acknowledge
                            .mutateAsync({
                              exportId: e.id,
                              status: "rejected",
                              rejectedReason: reason.trim(),
                            })
                            .then(() => {
                              setRejecting(null)
                              setReason("")
                              refresh()
                            })
                            .catch((err: Error) => setError(err.message))
                        }
                      />
                    </>
                  ) : null}
                </div>
              </div>
              {e.rejectedReason ? (
                <p className="mt-1 text-destructive text-xs">
                  Rejected by ERP: {e.rejectedReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* Manifest viewer with tamper check */}
      <Dialog
        open={!!manifestFor}
        onOpenChange={(open) => !open && setManifestFor(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Journal — {manifestFor?.runNumber}</DialogTitle>
            <DialogDescription>
              {manifest.isPending
                ? "Verifying hash…"
                : manifest.error
                  ? "Tamper check failed — the stored hash no longer matches."
                  : "Hash verified against the stored manifest."}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-y-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs">
            {manifest.data?.csv ?? ""}
          </pre>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Close</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function StatusChip({
  label,
  tone,
}: {
  label: string
  tone: "ok" | "warn" | "bad"
}) {
  return (
    <Badge variant={tone === "ok" ? "default" : "secondary"}>{label}</Badge>
  )
}

function ConfirmReject({
  armed,
  pending,
  reason,
  onReasonChange,
  onArm,
  onCancel,
  onConfirm,
}: {
  armed: boolean
  pending: boolean
  reason: string
  onReasonChange: (value: string) => void
  onArm: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!armed) {
    return (
      <Button size="sm" variant="outline" onClick={onArm}>
        Reject…
      </Button>
    )
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject journal</DialogTitle>
          <DialogDescription>
            The ERP refused this journal — record why so finance can replay it.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="Reason (required)"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length === 0 || pending}
            onClick={onConfirm}
          >
            Confirm rejection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
