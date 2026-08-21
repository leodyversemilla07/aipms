"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type AudRow = {
  id: string
  actorId: string
  actorKind: string
  action: string
  entity: string
  entityId: string | null
  inputHash: string | null
  before: unknown
  after: unknown
  at: string
}

/**
 * §16 — immutable, append-only trail viewer. Read-only: every state change
 * across the desks writes an entry (content-addressed inputHash, SHA-256);
 * the viewer filters by entity / action / free text and shows newest first.
 */
export function AuditViewer() {
  const trpc = useTRPC()
  const [q, setQ] = useState("")
  const [entity, setEntity] = useState("")
  const [action, setAction] = useState("")

  const meta = useQuery(trpc.audit.meta.queryOptions())
  const chain = useQuery(trpc.audit.chain.queryOptions())
  const feed = useQuery(
    trpc.audit.list.queryOptions({
      q,
      page: 1,
      pageSize: 100,
      entity: entity || undefined,
      action: action || undefined,
    })
  )
  const rows = (feed.data?.rows ?? []) as unknown as AudRow[]
  const entities = meta.data?.entities ?? []
  const actions = meta.data?.actions ?? []

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Audit trail
        </h2>
        <span className="text-muted-foreground text-xs">
          {feed.data?.total ?? rows.length} entries
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search action / entity / actor…"
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Entity (any)</option>
          {entities.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Action (any)</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {/* §16.3 — hash-chain integrity, recomputed live. */}
      {chain.data ? (
        chain.data.ok ? (
          <p className="rounded-md bg-primary/10 px-3 py-2 text-primary text-xs">
            Chain intact — {chain.data.checked} hashed entries verified
            {chain.data.legacy > 0
              ? ` · ${chain.data.legacy} legacy entries predate the chain`
              : ""}
          </p>
        ) : (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
            Chain broken at seq {chain.data.brokenAtSeq}: {chain.data.reason}
          </p>
        )
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No matching audit entries. Perform an action on any desk to record
          one.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border bg-card px-4 py-2 text-xs"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-foreground">
                  {r.action} · {r.entity}
                  {r.entityId ? `:${r.entityId.slice(0, 8)}` : ""}
                </span>
                <span className="text-muted-foreground">{fmtTime(r.at)}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                <span>
                  {r.actorKind} · {r.actorId.slice(0, 8)}
                </span>
                {r.inputHash ? (
                  <span className="font-mono" title={r.inputHash}>
                    sha256 {r.inputHash.slice(0, 16)}…
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
