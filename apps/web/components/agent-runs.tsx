"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type RunRow = {
  id: string
  agentId: string
  status: string
  skills: string[]
  meta: {
    triggeredBy?: string
    entityType?: string
    entityId?: string
  } | null
  startedAt: string
  finishedAt: string | null
}

const RUN_STATUS: Record<
  string,
  { label: string; tone: "ok" | "warn" | "bad" | "muted" }
> = {
  running: { label: "running", tone: "warn" },
  succeeded: { label: "succeeded", tone: "ok" },
  failed: { label: "failed", tone: "bad" },
  cancelled: { label: "cancelled", tone: "muted" },
}

/**
 * §7.1 — what is the agent doing right now? Recent agent runs with status,
 * active skills, and trigger metadata, so supervision starts with visibility.
 */
export function AgentRuns() {
  const trpc = useTRPC()
  const runsQuery = useQuery(
    trpc.agent.runs.queryOptions({ q: "", page: 1, pageSize: 8 })
  )
  const rows = (runsQuery.data?.rows ?? []) as unknown as RunRow[]

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Agent activity
        </h2>
        <span className="text-muted-foreground text-xs">
          {runsQuery.data?.total ?? "…"} runs
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No agent runs yet — runs appear here as agents drain intake or react
          to domain events.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const status = RUN_STATUS[r.status] ?? {
              label: r.status,
              tone: "muted" as const,
            }
            const duration =
              r.finishedAt && r.startedAt
                ? `${Math.max(
                    1,
                    Math.round(
                      (new Date(r.finishedAt).getTime() -
                        new Date(r.startedAt).getTime()) /
                        1000
                    )
                  )}s`
                : null
            return (
              <li
                key={r.id}
                className="rounded-lg border bg-card px-4 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        status.tone === "ok"
                          ? "default"
                          : status.tone === "bad"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {status.label}
                    </Badge>
                    {r.skills.map((s) => (
                      <span
                        key={s}
                        className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
                      >
                        {s}
                      </span>
                    ))}
                    <span className="text-muted-foreground text-xs">
                      agent {r.agentId.slice(0, 12)}
                    </span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {fmtTime(r.startedAt)}
                    {duration ? ` · ${duration}` : " · …"}
                  </span>
                </div>
                {r.meta?.triggeredBy ? (
                  <p className="mt-1 text-muted-foreground text-xs">
                    triggered by{" "}
                    <span className="font-mono">{r.meta.triggeredBy}</span>
                    {r.meta.entityType && r.meta.entityId
                      ? ` on ${r.meta.entityType} ${r.meta.entityId.slice(0, 12)}`
                      : ""}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
