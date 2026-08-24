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
import { Input } from "@workspace/ui/components/input"
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

/** aipms chart codes (§8.5 v1 defaults) → ERP account ids. */
const CHART_CODES = [
  { code: "2010", label: "Accounts Payable" },
  { code: "2020", label: "EWT Withholding Payable" },
  { code: "1010", label: "Cash Clearing" },
]

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
  const [notice, setNotice] = useState<string | null>(null)
  const [manifestFor, setManifestFor] = useState<ExportRow | null>(null)
  const [rejecting, setRejecting] = useState<ExportRow | null>(null)
  const [reason, setReason] = useState("")

  const exportsQuery = useQuery(
    trpc.erp.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (exportsQuery.data?.rows ?? []) as unknown as ExportRow[]

  const report = useQuery(trpc.erp.reconcileReport.queryOptions({}))
  const qbo = useQuery(trpc.erp.qboStatus.queryOptions({}))

  const manifest = useQuery({
    ...trpc.erp.manifest.queryOptions({ id: manifestFor?.id ?? "" }),
    enabled: !!manifestFor,
  })

  const acknowledge = useMutation(trpc.erp.acknowledge.mutationOptions())
  const pushQbo = useMutation(trpc.erp.qboPushExport.mutationOptions())
  const qboAuthorize = useMutation(trpc.erp.qboAuthorize.mutationOptions())
  const qboDisconnect = useMutation(trpc.erp.qboDisconnect.mutationOptions())
  const qboSyncAccounts = useMutation(
    trpc.erp.qboSyncAccounts.mutationOptions()
  )
  const qboSetMap = useMutation(
    trpc.erp.qboSetAccountMap.mutationOptions({
      onSuccess: () => setNotice("Chart map saved."),
    })
  )

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

      {notice ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-primary text-xs">
          {notice}
        </p>
      ) : null}

      {/* QuickBooks connector (§8.5 v1 anchor adapter) */}
      <QboPanel
        qbo={qbo.data}
        pending={
          pushQbo.isPending ||
          qboAuthorize.isPending ||
          qboDisconnect.isPending ||
          qboSyncAccounts.isPending ||
          qboSetMap.isPending
        }
        onConnect={() =>
          qboAuthorize
            .mutateAsync({})
            .then(({ url }) => {
              window.location.href = url
            })
            .catch((e: Error) => setError(e.message))
        }
        onDisconnect={() =>
          qboDisconnect
            .mutateAsync({})
            .then(refresh)
            .catch((e: Error) => setError(e.message))
        }
        onSyncAccounts={() =>
          qboSyncAccounts
            .mutateAsync({})
            .then(({ accounts }) => {
              setNotice(`Synced ${accounts.length} account(s) from QuickBooks.`)
              refresh()
            })
            .catch((e: Error) => setError(e.message))
        }
        onSaveMap={(map) =>
          qboSetMap
            .mutateAsync({ map })
            .then(() => refresh())
            .catch((e: Error) => setError(e.message))
        }
      />

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
                  {qbo.data?.connected && e.status === "exported" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pushQbo.isPending}
                      title="Create the journal in QuickBooks and settle this export"
                      onClick={() =>
                        pushQbo
                          .mutateAsync({ exportId: e.id })
                          .then((posted) => {
                            setNotice(
                              `Pushed to QuickBooks as JournalEntry ${posted.externalRef}.`
                            )
                            refresh()
                          })
                          .catch((err: Error) => setError(err.message))
                      }
                    >
                      Push to QBO
                    </Button>
                  ) : null}
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

type QboStatus = {
  connected: boolean
  realmId: string | null
  environment: string
  accountMap: Record<string, string>
  cachedAccounts: { id: string; name: string; type: string }[]
}

function QboPanel({
  qbo,
  pending,
  onConnect,
  onDisconnect,
  onSyncAccounts,
  onSaveMap,
}: {
  qbo?: QboStatus
  pending: boolean
  onConnect: () => void
  onDisconnect: () => void
  onSyncAccounts: () => void
  onSaveMap: (map: Record<string, string>) => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})

  if (!qbo) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3 text-muted-foreground text-xs">
        Loading QuickBooks status…
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">QuickBooks Online</span>
          <span className="text-muted-foreground text-xs">
            {qbo.environment}
            {qbo.connected && qbo.realmId ? ` · realm ${qbo.realmId}` : ""}
          </span>
          {qbo.connected ? (
            <Badge>connected</Badge>
          ) : (
            <Badge variant="secondary">not connected</Badge>
          )}
        </div>
        {qbo.connected ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onDisconnect}
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={pending} onClick={onConnect}>
            Connect QuickBooks…
          </Button>
        )}
      </div>

      {qbo.connected ? (
        <>
          <p className="text-muted-foreground text-xs">
            Map aipms chart codes onto QuickBooks accounts (ids come from the
            company&apos;s chart of accounts). Unmapped codes refuse to push —
            never mispost silently.
          </p>
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
            {CHART_CODES.map((c) => (
              <AccountMapRow
                key={c.code}
                code={c.code}
                label={c.label}
                value={draft[c.code] ?? qbo.accountMap[c.code] ?? ""}
                cached={qbo.cachedAccounts}
                onChange={(v) => setDraft((prev) => ({ ...prev, [c.code]: v }))}
              />
            ))}
            <span />
            <span />
            <Button
              size="xs"
              disabled={pending || Object.keys(draft).length === 0}
              title="Save the chart map"
              onClick={() => {
                const merged = { ...qbo.accountMap }
                for (const c of CHART_CODES) {
                  const v = draft[c.code]
                  if (v !== undefined && v !== "") merged[c.code] = v
                }
                onSaveMap(merged)
                setDraft({})
              }}
            >
              Save map
            </Button>
          </div>
          {qbo.cachedAccounts.length > 0 ? (
            <details className="text-muted-foreground text-xs">
              <summary className="cursor-pointer">
                Chart of accounts cache ({qbo.cachedAccounts.length})
              </summary>
              <ul className="mt-1 max-h-40 overflow-y-auto">
                {qbo.cachedAccounts.map((a) => (
                  <li key={a.id} className="font-mono">
                    {a.id} · {a.name} ({a.type})
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={onSyncAccounts}
            >
              Sync chart of accounts from QBO
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}

function AccountMapRow({
  code,
  label,
  value,
  cached,
  onChange,
}: {
  code: string
  label: string
  value: string
  cached: { id: string; name: string; type: string }[]
  onChange: (value: string) => void
}) {
  const id = `qbo-map-${code}`
  return (
    <>
      <label htmlFor={id} className="text-xs">
        <span className="font-mono">{code}</span> · {label}
      </label>
      <Input
        id={id}
        placeholder="QBO account id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={`qbo-accounts-${code}`}
        className="h-7 w-32 text-xs"
      />
      <datalist id={`qbo-accounts-${code}`}>
        {cached.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.type})
          </option>
        ))}
      </datalist>
      <span className="text-muted-foreground">
        {(() => {
          const match = cached.find((a) => a.id === value)
          return match ? `${match.name} (${match.type})` : ""
        })()}
      </span>
    </>
  )
}
