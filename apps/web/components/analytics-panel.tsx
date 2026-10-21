"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import type { ReactNode } from "react"
import { useState } from "react"
import { ErrorState, InlineError } from "@/components/states/error-state"
import { PendingLabel } from "@/components/states/pending-state"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

/**
 * §14 — operations metrics for the supervisory desk. Everything derives at
 * query time from approvals, requisitions, budgets, and agent runs; the
 * period selector bounds the window.
 */
export function AnalyticsPanel({ heading }: { heading?: ReactNode }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [months, setMonths] = useState("3")
  const [pruneNotice, setPruneNotice] = useState<string | null>(null)
  const [pruneError, setPruneError] = useState<string | null>(null)

  const overview = useQuery(
    trpc.analytics.overview.queryOptions({ months: Number(months) })
  )
  const retentionQuery = useQuery(trpc.analytics.retention.queryOptions())
  const pruneMutation = useMutation(
    trpc.analytics.pruneRetention.mutationOptions()
  )

  async function handlePrune() {
    setPruneNotice(null)
    setPruneError(null)
    try {
      const res = await pruneMutation.mutateAsync()
      setPruneNotice(
        `Pruned ${res.prunedIdempotencyKeys} idempotency keys and ${res.prunedRateLimits} rate limit buckets in ${res.durationMs}ms.`
      )
      queryClient.invalidateQueries(trpc.analytics.retention.pathFilter())
    } catch (e) {
      setPruneError((e as Error).message)
    }
  }

  const d = overview.data

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {heading === undefined ? (
          <h2 className="font-heading font-semibold text-xl tracking-tight">
            Financial control & operations
          </h2>
        ) : (
          heading
        )}
        <Select value={months} onValueChange={(v) => setMonths(v ?? "3")}>
          <SelectTrigger className="w-36" aria-label="Window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["1", "3", "6", "12"].map((m) => (
              <SelectItem key={m} value={m}>
                last {m} month{m === "1" ? "" : "s"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {overview.isError ? (
        <ErrorState
          title="Could not load operations metrics"
          message={overview.error.message}
        />
      ) : !d ? (
        <PendingLabel label="Computing" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Spend control stays above secondary operational metrics. */}
          <Card size="sm" className="md:col-span-2">
            <CardHeader>
              <CardTitle>Budget utilization · all periods</CardTitle>
            </CardHeader>
            <CardContent>
              {d.spend.length === 0 ? (
                <Empty>No budgets registered.</Empty>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {d.spend.map((b) => (
                    <li
                      key={`${b.costCenter}-${b.period}`}
                      className="flex flex-col gap-1 py-2"
                    >
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="font-medium">
                          {b.costCenter} · {b.period}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {minorToPhp(b.spentMinor)} spent /{" "}
                          {minorToPhp(b.limitMinor)} limit
                          {b.committedMinor > 0
                            ? ` (+${minorToPhp(b.committedMinor)} committed)`
                            : ""}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={
                            b.utilizationPct > 90
                              ? "h-full rounded-full bg-destructive"
                              : b.utilizationPct > 70
                                ? "h-full rounded-full bg-amber-500"
                                : "h-full rounded-full bg-primary"
                          }
                          style={{
                            width: `${Math.min(100, b.utilizationPct)}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Gate decisions in the selected window */}
          <MetricCard title="Gate decisions">
            {d.gates.byStatus.length === 0 ? (
              <Empty>No gate activity in this window.</Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {d.gates.byStatus.map((s) => (
                  <li key={s.status} className="flex justify-between text-xs">
                    <span className="capitalize">{s.status}</span>
                    <span className="font-mono">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </MetricCard>

          {/* Approval SLA */}
          <MetricCard title="Approval latency">
            {d.sla.decidedCount === 0 ? (
              <Empty>Nothing was decided in this window.</Empty>
            ) : (
              <div className="flex items-baseline gap-4 text-sm">
                <span>
                  <span className="font-semibold text-2xl tabular-nums">
                    {d.sla.medianMinutes ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {" "}
                    min median
                  </span>
                </span>
                <span className="text-muted-foreground text-xs">
                  p90 {d.sla.p90Minutes ?? "—"} min · {d.sla.decidedCount}{" "}
                  decided
                </span>
              </div>
            )}
          </MetricCard>

          {/* Exception volume */}
          <MetricCard title="Exception volume by month">
            {d.exceptionVolume.length === 0 ? (
              <Empty>No exceptions — clean run.</Empty>
            ) : (
              <div className="flex flex-col gap-1">
                {d.exceptionVolume.map((m) => (
                  <TrendRow
                    key={m.month}
                    label={m.month}
                    count={m.count}
                    max={Math.max(...d.exceptionVolume.map((e) => e.count))}
                  />
                ))}
              </div>
            )}
          </MetricCard>

          {/* Agent outcomes */}
          <MetricCard title="Agent runs by skill">
            {d.agents.bySkill.length === 0 ? (
              <Empty>No agent runs in this window.</Empty>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-0.5 text-left font-normal">skill</th>
                    <th className="py-0.5 text-right font-normal">ok</th>
                    <th className="py-0.5 text-right font-normal">fail</th>
                    <th className="py-0.5 text-right font-normal">total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.agents.bySkill.slice(0, 6).map((s) => (
                    <tr key={s.skill}>
                      <td className="py-0.5 font-mono">{s.skill}</td>
                      <td className="py-0.5 text-right">{s.succeeded}</td>
                      <td
                        className={`py-0.5 text-right ${s.failed > 0 ? "text-destructive" : ""}`}
                      >
                        {s.failed}
                      </td>
                      <td className="py-0.5 text-right font-mono">{s.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </MetricCard>

          <Card size="sm" className="md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle>Storage retention & hygiene</CardTitle>
              <Button
                size="sm"
                variant="outline"
                disabled={pruneMutation.isPending}
                onClick={() => void handlePrune()}
              >
                {pruneMutation.isPending ? "Pruning…" : "Prune expired rows"}
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {pruneNotice ? (
                <p className="rounded bg-emerald-500/10 px-3 py-1.5 text-emerald-600 text-xs">
                  {pruneNotice}
                </p>
              ) : null}
              {pruneError ? <InlineError message={pruneError} /> : null}
              {retentionQuery.data ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-xs">
                        Idempotency keys
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {retentionQuery.data.idempotency.retentionDays}-day
                        retention
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="font-bold font-mono text-xl">
                        {retentionQuery.data.idempotency.total}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {retentionQuery.data.idempotency.expired} expired
                      </span>
                    </div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-xs">
                        Rate limit buckets
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {retentionQuery.data.rateLimit.retentionDays}-day
                        retention
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between">
                      <span className="font-bold font-mono text-xl">
                        {retentionQuery.data.rateLimit.total}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {retentionQuery.data.rateLimit.expired} expired
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <Empty>Loading retention telemetry…</Empty>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  )
}

function MetricCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>
}

function TrendRow({
  label,
  count,
  max,
}: {
  label: string
  count: number
  max: number
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 shrink-0 font-mono text-muted-foreground">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-destructive/70"
          style={{
            width: `${max > 0 ? Math.max(4, (count / max) * 100) : 4}%`,
          }}
        />
      </div>
      <span className="w-8 text-right font-mono">{count}</span>
    </div>
  )
}
