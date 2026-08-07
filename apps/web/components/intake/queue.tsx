"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type DocRow = {
  id: string
  channel: string
  contentHash: string
  senderId: string | null
  status: string
  receivedAt: string
}

const CHANNELS = [
  "EMAIL_IMAP",
  "EINVOICE_EIS",
  "PEPPOL",
  "EDI",
  "API",
  "PORTAL",
]

const STATUSES = [
  "new",
  "classifying",
  "extracted",
  "matched",
  "exception",
  "dropped",
]

/**
 * §8.2 normalized ingestion queue. Documents arrive from any channel and are
 * deduped on [channel, contentHash]; the desk lets an operator classify the
 * extracted payload, drop a doc, or requeue one to the top.
 */
export function IntakeQueue() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState("")
  const [channel, setChannel] = useState(CHANNELS[0] ?? "")
  const [contentHash, setContentHash] = useState("")
  const [raw, setRaw] = useState("")
  const [occupied, setOccupied] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const feed = useQuery(
    trpc.intake.list.queryOptions({
      q: "",
      page: 1,
      pageSize: 100,
      status: (status || undefined) as never,
    })
  )
  const rows = (feed.data ?? []) as unknown as DocRow[]

  const ingest = useMutation(trpc.intake.ingest.mutationOptions())
  const classify = useMutation(trpc.intake.classify.mutationOptions())
  const dropMut = useMutation(trpc.intake.drop.mutationOptions())
  const requeue = useMutation(trpc.intake.requeue.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.intake.pathFilter())
  }

  async function doIngest() {
    setNotice(null)
    setError(null)
    try {
      let parsedRaw: unknown
      if (raw.trim()) {
        try {
          parsedRaw = JSON.parse(raw)
        } catch {
          setError("Raw payload must be valid JSON (or leave empty).")
          return
        }
      }
      const hash =
        contentHash.trim() || `doc-${Math.random().toString(36).slice(2)}`
      const res = await ingest.mutateAsync({
        idempotencyKey: `web-intake-${crypto.randomUUID()}`,
        channel,
        contentHash: hash,
        ...(parsedRaw !== undefined ? { raw: parsedRaw } : {}),
      })
      refresh()
      setNotice(
        res.status === "new"
          ? `Ingested ${res.channel}:${res.contentHash.slice(0, 10)}…`
          : `Already present (deduped) — ${res.id}`
      )
      setContentHash("")
      setRaw("")
    } catch (e) {
      setError(`Could not ingest: ${(e as Error).message}`)
    }
  }

  async function doClassify(id: string) {
    const rawField = occupied[id] ?? "{}"
    let payload: unknown
    try {
      payload = JSON.parse(rawField)
    } catch {
      setError("Classified payload must be valid JSON.")
      return
    }
    await classify.mutateAsync({ id, classified: payload })
    refresh()
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Ingest document
        </h2>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            value={contentHash}
            onChange={(e) => setContentHash(e.target.value)}
            placeholder="contentHash (blank = random)"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <Button size="sm" disabled={ingest.isPending} onClick={doIngest}>
            Ingest
          </Button>
        </div>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='Raw document payload as JSON, e.g. {"attachments":["INV-2026-0007.pdf"],"subject":"Invoice 0007"}'
          className="h-20 rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        {notice ? (
          <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Queue
        </h2>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No documents. Ingest one above — re-ingest with the same [channel,
          contentHash] is deduped.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-medium">
                    {doc.channel} · {doc.contentHash.slice(0, 12)}…
                  </span>
                  <span className="text-muted-foreground text-xs">
                    status {doc.status} · received {fmtTime(doc.receivedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {doc.status !== "dropped" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={classify.isPending || !!occupied[doc.id]}
                        onClick={() => doClassify(doc.id)}
                      >
                        Classify
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={dropMut.isPending}
                        onClick={() =>
                          dropMut.mutateAsync({ id: doc.id }).then(refresh)
                        }
                      >
                        Drop
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={requeue.isPending}
                      onClick={() =>
                        requeue.mutateAsync({ id: doc.id }).then(refresh)
                      }
                    >
                      Requeue
                    </Button>
                  )}
                </div>
              </div>
              <textarea
                value={
                  occupied[doc.id] ??
                  JSON.stringify({ kind: "invoice" }, null, 2)
                }
                onChange={(e) =>
                  setOccupied((prev) => ({ ...prev, [doc.id]: e.target.value }))
                }
                placeholder='Classified payload JSON, e.g. {"kind":"invoice","amountMinor":100000}'
                rows={2}
                className="w-full rounded-md border bg-background px-3 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
