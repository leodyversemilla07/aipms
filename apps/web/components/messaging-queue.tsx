"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { useState } from "react"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type MessageRow = {
  id: string
  vendorId: string
  recipient: string
  subject: string
  body: string
  templateId: string | null
  tier: string
  status: string
  agentId: string | null
  rejectedReason: string | null
  sentAt: string | null
  createdAt: string
}

const STATUS_FILTERS = ["queued", "approved", "sent", "rejected", "failed"]

/**
 * §8.3 — vendor messaging relay approvals. Transactional templates auto-send;
 * everything else queues here as `gated` and needs a human decision.
 * Approve/reject are role-gated server-side (procurement | finance).
 */
export function MessagingQueue() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [status, setStatus] = useState("queued")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)

  const messages = useQuery(
    trpc.messaging.list.queryOptions({
      q: "",
      page: 1,
      pageSize: 50,
      status: (status || undefined) as never,
    })
  )
  const rows = (messages.data?.rows ?? []) as unknown as MessageRow[]

  const approve = useMutation(trpc.messaging.approve.mutationOptions())
  const reject = useMutation(trpc.messaging.reject.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.messaging.pathFilter())
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Vendor messages
        </h2>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              size="xs"
              variant={status === s ? "default" : "ghost"}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No {status} messages.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              expanded={!!expanded[m.id]}
              onToggle={() =>
                setExpanded((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
              }
              approvePending={approve.isPending}
              rejectPending={reject.isPending}
              onApprove={() =>
                approve
                  .mutateAsync({ id: m.id })
                  .then(refresh)
                  .catch((e: Error) => setError(e.message))
              }
              onReject={(reason) =>
                reject
                  .mutateAsync({ id: m.id, reason })
                  .then(refresh)
                  .catch((e: Error) => setError(e.message))
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function MessageItem({
  message,
  expanded,
  onToggle,
  approvePending,
  rejectPending,
  onApprove,
  onReject,
}: {
  message: MessageRow
  expanded: boolean
  onToggle: () => void
  approvePending: boolean
  rejectPending: boolean
  onApprove: () => void
  onReject: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  const [rejecting, setRejecting] = useState(false)

  return (
    <li className="rounded-lg border bg-card px-4 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex flex-col items-start text-left"
          onClick={onToggle}
        >
          <span className="flex items-center gap-2 font-medium">
            {message.subject}
            {message.tier === "gated" ? (
              <Badge variant="secondary">gated</Badge>
            ) : (
              <Badge variant="outline">auto</Badge>
            )}
          </span>
          <span className="text-muted-foreground text-xs">
            vendor {message.vendorId.slice(0, 8)} → {message.recipient} ·{" "}
            {fmtTime(message.createdAt)}
            {message.agentId
              ? ` · agent ${message.agentId.slice(0, 8)}`
              : " · human"}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <StatusChip status={message.status} />
          {message.status === "queued" && message.tier === "gated" ? (
            <>
              <Button size="sm" disabled={approvePending} onClick={onApprove}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={rejectPending}
                onClick={() => setRejecting((v) => !v)}
              >
                Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {expanded || rejecting ? (
        <pre className="mt-2 max-h-48 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
          {message.body}
        </pre>
      ) : null}
      {message.rejectedReason ? (
        <p className="mt-1 text-destructive text-xs">
          Rejected: {message.rejectedReason}
        </p>
      ) : null}

      {rejecting ? (
        <div className="mt-2 flex items-end gap-2">
          <Textarea
            placeholder="Rejection reason (required)"
            className="min-h-9"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={reason.trim().length === 0 || rejectPending}
            onClick={() => {
              onReject(reason.trim())
              setRejecting(false)
              setReason("")
            }}
          >
            Confirm reject
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    queued: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    approved: "bg-primary/10 text-primary",
    sent: "bg-primary/10 text-primary",
    rejected: "bg-destructive/10 text-destructive",
    failed: "bg-destructive/10 text-destructive",
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${styles[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {status}
    </span>
  )
}
