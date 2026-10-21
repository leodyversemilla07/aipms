"use client"

import { useQuery } from "@tanstack/react-query"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { useEffect, useState } from "react"
import { PageControls } from "@/components/page-controls"
import { EmptyState } from "@/components/states/empty-state"
import { ErrorState, InlineError } from "@/components/states/error-state"
import { PendingState } from "@/components/states/pending-state"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

const PAGE_SIZE = 25

type AudRow = {
  id: string
  actorId: string
  actorKind: string
  action: string
  entity: string
  entityId: string | null
  inputHash: string | null
  at: string | Date
}

type CheckpointInput = { seq: number; entryHash: string }

/**
 * Accepts a retained checkpoint as JSON (`{"seq":42,"entryHash":"…"}`) or as
 * the shorthand `42 <hash>`, so an operator can paste back what they kept.
 */
function parseCheckpoint(raw: string): CheckpointInput | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "seq" in parsed &&
        "entryHash" in parsed &&
        typeof parsed.seq === "number" &&
        typeof parsed.entryHash === "string"
      ) {
        return { seq: parsed.seq, entryHash: parsed.entryHash }
      }
    } catch {
      return null
    }
    return null
  }
  const [seq, entryHash] = trimmed.split(/[\s:]+/, 2)
  const parsedSeq = Number(seq)
  if (!Number.isInteger(parsedSeq) || !entryHash) return null
  return { seq: parsedSeq, entryHash }
}

const CHECKPOINT_VERDICT: Record<
  string,
  { title: string; destructive: boolean }
> = {
  advanced: {
    title: "Trail matches the retained checkpoint",
    destructive: false,
  },
  truncated: {
    title: "Trail tip was removed",
    destructive: true,
  },
  rewritten: {
    title: "Checkpointed entry was rewritten",
    destructive: true,
  },
  missing: {
    title: "Checkpointed entry is gone",
    destructive: true,
  },
}

/** Read-only, server-paginated view of the immutable audit trail. */
export function AuditViewer() {
  const trpc = useTRPC()
  const [q, setQ] = useState("")
  const [entity, setEntity] = useState("")
  const [action, setAction] = useState("")
  const [page, setPage] = useState(1)

  const meta = useQuery(trpc.audit.meta.queryOptions())
  const checkpoint = useQuery(trpc.audit.checkpoint.queryOptions())
  const [expectedInput, setExpectedInput] = useState("")
  const [copied, setCopied] = useState(false)
  const expected = parseCheckpoint(expectedInput)
  const chain = useQuery({
    ...trpc.audit.chain.queryOptions({ expected: expected ?? undefined }),
    enabled: false,
    retry: false,
  })
  const feed = useQuery(
    trpc.audit.list.queryOptions({
      q,
      page,
      pageSize: PAGE_SIZE,
      entity: entity || undefined,
      action: action || undefined,
    })
  )
  const rows = (feed.data?.rows ?? []) as AudRow[]
  const total = feed.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // An external writer can remove results from a filtered page between reads.
  useEffect(() => {
    if (feed.data && page > totalPages) setPage(totalPages)
  }, [feed.data, page, totalPages])

  return (
    <section aria-label="Audit entries" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(event) => {
            setQ(event.target.value)
            setPage(1)
          }}
          aria-label="Search audit entries"
          placeholder="Search action, entity or actor…"
          className="min-w-52 flex-1"
        />
        <NativeSelect
          aria-label="Filter by entity"
          value={entity}
          onChange={(event) => {
            setEntity(event.target.value)
            setPage(1)
          }}
        >
          <NativeSelectOption value="">All entities</NativeSelectOption>
          {(meta.data?.entities ?? []).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value)
            setPage(1)
          }}
        >
          <NativeSelectOption value="">All actions</NativeSelectOption>
          {(meta.data?.actions ?? []).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {meta.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Filters unavailable</AlertTitle>
          <AlertDescription>{meta.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={chain.isFetching}
          onClick={() => void chain.refetch()}
        >
          {chain.isFetching ? "Verifying full chain…" : "Verify full chain"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Full verification reads every entry; it runs only on request.
        </span>
      </div>
      {chain.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not verify audit chain</AlertTitle>
          <AlertDescription>{chain.error.message}</AlertDescription>
        </Alert>
      ) : chain.data ? (
        <Alert variant={chain.data.ok ? "default" : "destructive"}>
          <AlertTitle>
            {chain.data.ok
              ? "Chain intact at last check"
              : "Chain integrity warning"}
          </AlertTitle>
          <AlertDescription>
            {chain.data.ok
              ? `${chain.data.checked} hashed entries verified${chain.data.legacy > 0 ? ` · ${chain.data.legacy} legacy entries predate the chain` : ""}`
              : `Broken at seq ${chain.data.brokenAtSeq}: ${chain.data.reason}`}
            {` · checked ${new Date(chain.dataUpdatedAt).toLocaleString()}.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Chain checkpoint</CardTitle>
          <CardDescription>
            Copy the current head and keep it outside the database. Verifying
            against it later proves the trail still ends where it did - the only
            way to notice a removed tip.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="outline">seq {checkpoint.data?.seq ?? "—"}</Badge>
              <span className="font-mono text-muted-foreground text-xs">
                {checkpoint.data
                  ? `sha256 ${checkpoint.data.entryHash.slice(0, 16)}…`
                  : "—"}
              </span>
              {checkpoint.data ? (
                <span className="text-muted-foreground text-xs">
                  {checkpoint.data.total} entries ·{" "}
                  {new Date(checkpoint.data.at).toLocaleString()}
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!checkpoint.data}
                onClick={() => {
                  if (!checkpoint.data) return
                  const payload = JSON.stringify(checkpoint.data)
                  void navigator.clipboard.writeText(payload).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
                }}
              >
                {copied ? "Copied" : "Copy checkpoint"}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={expectedInput}
                onChange={(event) => setExpectedInput(event.target.value)}
                aria-label="Retained checkpoint"
                placeholder="Retained checkpoint: 42 sha256…"
                className="min-w-52 flex-1 font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!expected || chain.isFetching}
                onClick={() => void chain.refetch()}
              >
                {chain.isFetching ? "Verifying…" : "Verify against checkpoint"}
              </Button>
            </div>
            {expectedInput && !expected ? (
              <InlineError
                message={
                  <>
                    That is not a checkpoint. Paste the copied JSON, or the
                    sequence and hash as <code>42 sha256…</code>.
                  </>
                }
              />
            ) : null}
            {chain.data?.checkpoint ? (
              <Alert
                variant={
                  CHECKPOINT_VERDICT[chain.data.checkpoint.status]?.destructive
                    ? "destructive"
                    : "default"
                }
              >
                <AlertTitle>
                  {CHECKPOINT_VERDICT[chain.data.checkpoint.status]?.title ??
                    "Checkpoint comparison"}
                </AlertTitle>
                <AlertDescription>
                  {chain.data.checkpoint.detail}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Entries</CardTitle>
          <CardDescription>
            {feed.data
              ? `${total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total} entries · newest first`
              : "Newest entries first"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {feed.isPending ? (
            <PendingState label="Loading audit entries" rows={3} />
          ) : feed.isError ? (
            <ErrorState
              title="Could not load audit entries"
              message={feed.error.message}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No matching entries"
              description="Try another filter, or perform an action on a desk to record one."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Input hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground text-xs">
                      {fmtTime(row.at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{row.actorKind}</Badge>
                        <span className="font-mono text-xs" title={row.actorId}>
                          {row.actorId.slice(0, 8)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.action}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.entity}
                      {row.entityId ? `:${row.entityId.slice(0, 8)}` : ""}
                    </TableCell>
                    <TableCell
                      className="font-mono text-muted-foreground text-xs"
                      title={row.inputHash ?? undefined}
                    >
                      {row.inputHash
                        ? `sha256 ${row.inputHash.slice(0, 16)}…`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {feed.data && total > PAGE_SIZE ? (
          <CardFooter className="flex flex-wrap justify-between gap-3 border-t">
            <span className="text-muted-foreground text-sm" role="status">
              Page {page} of {totalPages}
            </span>
            <PageControls
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </CardFooter>
        ) : null}
      </Card>
    </section>
  )
}
