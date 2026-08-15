"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
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
  const registerMut = useMutation(trpc.intake.registerInvoice.mutationOptions())
  const agentMut = useMutation(trpc.agent.process.mutationOptions())
  const batchMut = useMutation(trpc.agent.batch.mutationOptions())
  const [batchNotice, setBatchNotice] = useState<string | null>(null)
  const [registerNotice, setRegisterNotice] = useState<Record<string, string>>(
    {}
  )

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

  async function doRegister(id: string) {
    try {
      const res = await registerMut.mutateAsync({
        id,
        idempotencyKey: `web-bridge-${id}-${crypto.randomUUID()}`,
      })
      const inv = res.invoice as { number?: string; status?: string }
      setRegisterNotice((prev) => ({
        ...prev,
        [id]: `Invoice ${inv.number ?? ""} ${inv.status ?? ""} · match ${res.match?.outcome ?? "n/a"}`,
      }))
      refresh()
    } catch (e) {
      setRegisterNotice((prev) => ({
        ...prev,
        [id]: `Failed: ${(e as Error).message}`,
      }))
    }
  }

  async function doAgent(id: string) {
    try {
      const res = await agentMut.mutateAsync({
        id,
        idempotencyKey: `web-agent-${id}-${crypto.randomUUID()}`,
      })
      const inv = res.invoice as { number?: string; status?: string }
      setRegisterNotice((prev) => ({
        ...prev,
        [id]: `Agent: Invoice ${inv.number ?? ""} ${inv.status ?? ""} · match ${res.match?.outcome ?? "n/a"}`,
      }))
      refresh()
    } catch (e) {
      setRegisterNotice((prev) => ({
        ...prev,
        [id]: `Agent failed: ${(e as Error).message}`,
      }))
    }
  }

  async function doBatch() {
    try {
      const res = await batchMut.mutateAsync({ limit: 10 })
      const failed = res.failed.map((f) => f.docId.slice(0, 8)).join(", ")
      setBatchNotice(
        `Ran agent over ${res.documents} doc(s): ${res.succeeded} processed` +
          (res.failed.length ? `, ${res.failed.length} failed (${failed})` : ``)
      )
      refresh()
    } catch (e) {
      setBatchNotice(`Batch failed: ${(e as Error).message}`)
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
        <FieldGroup className="flex-wrap items-end gap-2">
          <Field>
            <Label htmlFor="channel-select">Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v ?? "")}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label htmlFor="content-hash">Hash</Label>
            <Input
              id="content-hash"
              value={contentHash}
              onChange={(e) => setContentHash(e.target.value)}
              placeholder="contentHash (blank = random)"
              className="h-9 flex-1"
            />
            <FieldDescription>Fetched or generated SHA256.</FieldDescription>
          </Field>
          <Button size="sm" disabled={ingest.isPending} onClick={doIngest}>
            Ingest
          </Button>
        </FieldGroup>

        <Field>
          <Label htmlFor="raw-payload">Raw payload</Label>
          <Textarea
            id="raw-payload"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder='{"attachments":["INV-0007.pdf"],"subject":"Invoice 0007"}'
            className="font-mono text-xs"
            rows={4}
          />
          <FieldDescription>
            Jagged JSON envelope from document.
          </FieldDescription>
        </Field>

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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={batchMut.isPending}
            onClick={doBatch}
          >
            {batchMut.isPending ? "Processing…" : "Run agent (pending)"}
          </Button>
          <Field>
            <Label htmlFor="status-filter">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v ?? "")}>
              <SelectTrigger className="h-8">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {batchNotice ? (
          <p className="rounded-md bg-emerald-500/10 px-3 py-1 text-emerald-600 text-xs">
            {batchNotice}
          </p>
        ) : null}
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
                      {doc.status === "new" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={agentMut.isPending}
                          onClick={() => doAgent(doc.id)}
                        >
                          Auto-extract
                        </Button>
                      ) : null}
                      <ConfirmButton
                        message="Drop document?"
                        disabled={dropMut.isPending}
                        onConfirm={() =>
                          dropMut.mutateAsync({ id: doc.id }).then(refresh)
                        }
                      >
                        Drop
                      </ConfirmButton>
                      {doc.status === "extracted" ? (
                        <Button
                          size="sm"
                          variant="default"
                          disabled={registerMut.isPending}
                          onClick={() => doRegister(doc.id)}
                        >
                          Register invoice
                        </Button>
                      ) : null}
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

              <Field>
                <Label htmlFor={`payload-${doc.id}-raw`}>
                  Extracted payload
                </Label>
                <Textarea
                  id={`payload-${doc.id}-raw`}
                  value={
                    occupied[doc.id] ??
                    JSON.stringify({ kind: "invoice" }, null, 2)
                  }
                  onChange={(e) =>
                    setOccupied((prev) => ({
                      ...prev,
                      [doc.id]: e.target.value,
                    }))
                  }
                  placeholder='{"kind":"invoice","amountMinor":100000}'
                  rows={2}
                  className="font-mono text-xs"
                />
              </Field>

              {registerNotice[doc.id] ? (
                <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
                  {registerNotice[doc.id]}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
