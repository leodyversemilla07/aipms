"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
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
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import Link from "next/link"
import { useState } from "react"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"
import { SignInCard } from "./sign-in"
import { SignOutButton } from "./sign-out-button"

type DeadLetter = {
  id: string
  type: string
  entityType: string
  entityId: string
  attemptCount: number
  lastError: string | null
  deadLetteredAt: string | Date | null
  deadLetterReason: string | null
  createdAt: string | Date
}

type StaleRun = {
  id: string
  agentId: string
  skills: string[]
  status: string
  startedAt: string | Date
}

type FailedMessage = {
  id: string
  recipient: string
  subject: string
  tier: string
  failedReason: string | null
  dispatchStartedAt: string | Date | null
}

type DeliveryOutcome = "confirmed_sent" | "confirmed_not_sent"

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The recovery action failed."
}

function RecoveryConsole() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const [selected, setSelected] = useState<DeadLetter | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [staleRun, setStaleRun] = useState<StaleRun | null>(null)
  const [staleReason, setStaleReason] = useState("")
  const [staleError, setStaleError] = useState<string | null>(null)
  const [failedMessage, setFailedMessage] = useState<FailedMessage | null>(null)
  const [deliveryOutcome, setDeliveryOutcome] =
    useState<DeliveryOutcome | null>(null)
  const [deliveryEvidence, setDeliveryEvidence] = useState("")
  const [deliveryError, setDeliveryError] = useState<string | null>(null)

  const summary = useQuery(trpc.events.recoverySummary.queryOptions({}))
  const deadLetters = useQuery(
    trpc.events.deadLetters.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (deadLetters.data?.rows ?? []) as DeadLetter[]
  const staleRuns = useQuery(
    trpc.agent.staleRuns.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const staleRows = (staleRuns.data?.rows ?? []) as StaleRun[]
  const failedMessages = useQuery(
    trpc.messaging.list.queryOptions({
      q: "",
      page: 1,
      pageSize: 50,
      status: "failed",
    })
  )
  const failedRows = (failedMessages.data?.rows ?? []) as FailedMessage[]
  const requeue = useMutation(
    trpc.events.requeue.mutationOptions({
      onSuccess: () => {
        setSelected(null)
        setReason("")
        setError(null)
        queryClient.invalidateQueries(trpc.events.pathFilter())
      },
      onError: (cause) => setError(errorMessage(cause)),
    })
  )

  const cancelStaleRun = useMutation(
    trpc.agent.cancelStaleRun.mutationOptions()
  )
  const resolveFailedMessage = useMutation(
    trpc.messaging.resolveFailed.mutationOptions()
  )

  function submitRecovery() {
    if (!selected || !reason.trim()) return
    setError(null)
    requeue.mutate({
      id: selected.id,
      idempotencyKey: crypto.randomUUID(),
      reason: reason.trim(),
    })
  }

  async function submitStaleCancellation() {
    if (!staleRun || !staleReason.trim()) return
    setStaleError(null)
    try {
      await cancelStaleRun.mutateAsync({
        id: staleRun.id,
        idempotencyKey: crypto.randomUUID(),
        reason: staleReason.trim(),
      })
      setStaleRun(null)
      setStaleReason("")
      queryClient.invalidateQueries(trpc.agent.pathFilter())
      queryClient.invalidateQueries(trpc.events.pathFilter())
    } catch (cause) {
      setStaleError(errorMessage(cause))
    }
  }

  async function submitDeliveryResolution() {
    if (!failedMessage || !deliveryOutcome || !deliveryEvidence.trim()) return
    setDeliveryError(null)
    try {
      await resolveFailedMessage.mutateAsync({
        id: failedMessage.id,
        idempotencyKey: crypto.randomUUID(),
        outcome: deliveryOutcome,
        evidence: deliveryEvidence.trim(),
      })
      setFailedMessage(null)
      setDeliveryOutcome(null)
      setDeliveryEvidence("")
      queryClient.invalidateQueries(trpc.messaging.pathFilter())
      queryClient.invalidateQueries(trpc.events.pathFilter())
    } catch (cause) {
      setDeliveryError(errorMessage(cause))
    }
  }

  const stats = [
    ["Dead letters", summary.data?.deadLetters],
    ["Stale relay claims", summary.data?.staleRelayClaims],
    ["Stale agent runs", summary.data?.staleAgentRuns],
    ["Failed messages", summary.data?.failedMessages],
    ["Ambiguous QBO", summary.data?.ambiguousErpDispatches],
  ] as const

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">
            Operations recovery
          </h1>
          <p className="text-muted-foreground text-sm">
            {session?.user.email} · audited exception handling
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Supervisory desk
          </Link>
          <Link
            href="/finance"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Finance
          </Link>
          <Link
            href="/audit"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Audit
          </Link>
          <SignOutButton />
        </nav>
      </header>

      {summary.isError ||
      deadLetters.isError ||
      staleRuns.isError ||
      failedMessages.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Recovery data unavailable</AlertTitle>
          <AlertDescription>
            This desk requires finance or administrator access. Reload after
            checking the API and your assigned role.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map(([label, value]) => (
          <Card key={label} size="sm">
            <CardHeader>
              <CardTitle className="text-sm">{label}</CardTitle>
              <CardDescription>current exceptions</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="font-semibold text-2xl tabular-nums">
                {summary.isPending ? "…" : (value ?? 0)}
              </span>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-semibold">Domain-event dead letters</h2>
            <p className="text-muted-foreground text-sm">
              Requeue only after the subscriber fault has been repaired and
              verified. Every release records the operator and reason.
            </p>
          </div>
          <Badge variant={rows.length > 0 ? "destructive" : "secondary"}>
            {deadLetters.data?.total ?? "…"}
          </Badge>
        </div>

        {!deadLetters.isPending && rows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No dead-lettered events</EmptyTitle>
              <EmptyDescription>
                The outbox has no events requiring operator recovery.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="destructive">dead letter</Badge>
                    <span className="font-mono">{event.type}</span>
                    <span className="text-muted-foreground text-xs">
                      {event.entityType} {event.entityId.slice(0, 16)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelected(event)
                      setReason("")
                      setError(null)
                    }}
                  >
                    Review and requeue
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  {event.attemptCount} attempts · dead-lettered{" "}
                  {event.deadLetteredAt
                    ? fmtTime(event.deadLetteredAt)
                    : "at an unknown time"}
                </p>
                <p className="break-words text-xs">
                  {event.deadLetterReason ??
                    event.lastError ??
                    "No error detail"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-semibold">Stale agent runs</h2>
            <p className="text-muted-foreground text-sm">
              Cancel only after confirming that no worker still owns the run.
              Cancellation closes supervision state; it does not replay work.
            </p>
          </div>
          <Badge variant={staleRows.length > 0 ? "destructive" : "secondary"}>
            {staleRuns.data?.total ?? "…"}
          </Badge>
        </div>

        {!staleRuns.isPending && staleRows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No stale agent runs</EmptyTitle>
              <EmptyDescription>
                No running execution exceeds the configured automation lease.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {staleRows.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="destructive">stale</Badge>
                    <span className="font-mono">{run.id}</span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    agent {run.agentId} · started {fmtTime(run.startedAt)} ·{" "}
                    {run.skills.join(", ") || "no skills recorded"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setStaleRun(run)
                    setStaleReason("")
                    setStaleError(null)
                  }}
                >
                  Review and cancel
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-semibold">Failed vendor messages</h2>
            <p className="text-muted-foreground text-sm">
              Reconcile with the transport provider before closing or retrying
              an ambiguous delivery. Automatic retries are prohibited.
            </p>
          </div>
          <Badge variant={failedRows.length > 0 ? "destructive" : "secondary"}>
            {failedMessages.data?.total ?? "…"}
          </Badge>
        </div>

        {!failedMessages.isPending && failedRows.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No failed messages</EmptyTitle>
              <EmptyDescription>
                The outbound relay has no failures requiring reconciliation.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {failedRows.map((message) => (
              <li
                key={message.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm"
              >
                <div className="flex max-w-2xl flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="destructive">failed</Badge>
                    <span className="font-medium">{message.subject}</span>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {message.recipient} · {message.tier} · attempt{" "}
                    {message.dispatchStartedAt
                      ? fmtTime(message.dispatchStartedAt)
                      : "time unavailable"}
                  </span>
                  <span className="break-words text-xs">
                    {message.failedReason ?? "No transport error detail"}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFailedMessage(message)
                    setDeliveryOutcome(null)
                    setDeliveryEvidence("")
                    setDeliveryError(null)
                  }}
                >
                  Reconcile delivery
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Alert>
        <AlertTitle>Independent financial recovery</AlertTitle>
        <AlertDescription>
          QBO dispatch resolution remains on the Finance desk to preserve its
          dedicated maker/checker flow. Message redispatch is available only
          after an operator records provider evidence that delivery did not
          occur.
        </AlertDescription>
      </Alert>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !requeue.isPending) setSelected(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Requeue domain event</DialogTitle>
            <DialogDescription>
              Confirm that the underlying subscriber is healthy. Requeueing
              resets the delivery attempts and makes this event eligible for the
              relay again.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="recovery-reason">Recovery evidence</FieldLabel>
            <Textarea
              id="recovery-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Describe the repair and verification performed"
              aria-invalid={!!error}
              disabled={requeue.isPending}
            />
            <FieldDescription>
              Required and written to the append-only audit trail.
            </FieldDescription>
          </Field>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Requeue failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={requeue.isPending} />}
            >
              Cancel
            </DialogClose>
            <Button
              onClick={submitRecovery}
              disabled={!reason.trim() || requeue.isPending}
            >
              {requeue.isPending ? "Requeueing…" : "Requeue event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!staleRun}
        onOpenChange={(open) => {
          if (!open && !cancelStaleRun.isPending) setStaleRun(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel stale agent run</DialogTitle>
            <DialogDescription>
              Confirm from worker logs and leases that this execution is no
              longer active. This closes the stale run without replaying any
              command or domain mutation.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!staleError}>
            <FieldLabel htmlFor="stale-run-reason">
              Recovery evidence
            </FieldLabel>
            <Textarea
              id="stale-run-reason"
              value={staleReason}
              onChange={(event) => setStaleReason(event.target.value)}
              placeholder="Describe the lease and worker checks performed"
              aria-invalid={!!staleError}
              disabled={cancelStaleRun.isPending}
            />
            <FieldDescription>
              Required and written to the append-only audit trail.
            </FieldDescription>
          </Field>
          {staleError ? (
            <Alert variant="destructive">
              <AlertTitle>Cancellation failed</AlertTitle>
              <AlertDescription>{staleError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={cancelStaleRun.isPending} />
              }
            >
              Keep running
            </DialogClose>
            <Button
              variant="destructive"
              onClick={submitStaleCancellation}
              disabled={!staleReason.trim() || cancelStaleRun.isPending}
            >
              {cancelStaleRun.isPending ? "Cancelling…" : "Cancel stale run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!failedMessage}
        onOpenChange={(open) => {
          if (!open && !resolveFailedMessage.isPending) setFailedMessage(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconcile message delivery</DialogTitle>
            <DialogDescription>
              Use transport-provider evidence to confirm the external outcome. A
              confirmed non-delivery authorizes one new claimed dispatch.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Provider-confirmed outcome</FieldLabel>
            <ToggleGroup
              aria-label="Provider-confirmed outcome"
              value={deliveryOutcome ? [deliveryOutcome] : []}
              onValueChange={(values) =>
                setDeliveryOutcome((values[0] as DeliveryOutcome) ?? null)
              }
              variant="outline"
              spacing={0}
              disabled={resolveFailedMessage.isPending}
            >
              <ToggleGroupItem value="confirmed_sent">
                Delivery confirmed
              </ToggleGroupItem>
              <ToggleGroupItem value="confirmed_not_sent">
                Non-delivery confirmed
              </ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              Do not authorize redispatch when the provider outcome remains
              unknown.
            </FieldDescription>
          </Field>
          <Field data-invalid={!!deliveryError}>
            <FieldLabel htmlFor="delivery-evidence">
              Provider evidence
            </FieldLabel>
            <Textarea
              id="delivery-evidence"
              value={deliveryEvidence}
              onChange={(event) => setDeliveryEvidence(event.target.value)}
              placeholder="Record the provider case, delivery log, and checks performed"
              aria-invalid={!!deliveryError}
              disabled={resolveFailedMessage.isPending}
            />
            <FieldDescription>
              Required and written to the append-only audit trail.
            </FieldDescription>
          </Field>
          {deliveryError ? (
            <Alert variant="destructive">
              <AlertTitle>Resolution failed</AlertTitle>
              <AlertDescription>{deliveryError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  disabled={resolveFailedMessage.isPending}
                />
              }
            >
              Leave unresolved
            </DialogClose>
            <Button
              variant={
                deliveryOutcome === "confirmed_not_sent"
                  ? "destructive"
                  : "default"
              }
              onClick={submitDeliveryResolution}
              disabled={
                !deliveryOutcome ||
                !deliveryEvidence.trim() ||
                resolveFailedMessage.isPending
              }
            >
              {resolveFailedMessage.isPending
                ? "Resolving…"
                : deliveryOutcome === "confirmed_not_sent"
                  ? "Authorize one retry"
                  : "Record confirmed delivery"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function OperationsDesk() {
  const { data: session, isPending } = authClient.useSession()
  if (isPending) {
    return (
      <p className="py-24 text-center text-muted-foreground text-sm">
        Checking session…
      </p>
    )
  }
  if (!session) {
    return (
      <main className="flex min-h-svh items-center justify-center p-4">
        <SignInCard />
      </main>
    )
  }
  return <RecoveryConsole />
}
