# Shared agent admission

The API uses one `AgentQuotaService` for authorized tRPC mutations and agent
commands invoked by REST batches, the scheduler, event wakes and IMAP ingestion.
This is an admission control, not authorization, idempotency, financial approval,
external-delivery recovery, or a distributed execution lease.

## Accounting

- Defaults: **60 mutation admissions/minute per principal**, **4 root commands
  in flight per principal per API process**. Configure positive database-range
  integers with `AIPMS_AGENT_RATE_LIMIT` and `AIPMS_AGENT_CONCURRENCY`.
  Invalid environment configuration refuses API startup.
- Each rate admission atomically increments the existing PostgreSQL `RateLimit`
  bucket `agent-mutation-rate:<actorId>:<UTC-minute-number>`. Different API
  instances share this counter. Clocks must be synchronized.
- When an agent `User` row exists, its current server-owned
  `quotas.mutationsPerMinute` overrides the default. It must be a positive JSON
  integer, not a numeric string. Malformed configuration and principal IDs
  colliding with human rows fail closed; absent agent rows use the defaults.
  Session/body/token quota overrides are never trusted.
- A batch bills its envelope, even for an empty queue, **plus each attempted
  document**. A 25-document batch needs 26 admissions. IMAP ingestion and later
  invoice processing are separate mutations. PO issuance is independently
  admitted. Run/audit/outbox bookkeeping is not a separate business admission.
- Nested adapters for the *same operation and principal* reuse admission.
  Distinct child commands consume rate but reuse the parent's concurrency slot;
  batches process documents sequentially. The reuse context is internal async
  state, not a caller-supplied `source` flag.
- Authorization/capability checks precede admission. Humans and agent queries
  are not limited by this machine budget. Existing role, scope, maker/checker,
  idempotency, payment and transport safeguards still apply. This does not grant
  agents access to human-only `agent.process`/`agent.batch` tRPC procedures.
- Rate is spent before business work and remains spent on business rollback,
  errors and idempotency replay. Over-budget attempts increment the bucket but
  perform no business callback. Concurrency refusals do not consume rate.
  Database failures are not treated as counter races or allowed through.
- Slots are synchronously reserved before database awaits and released in
  `finally`, including failures. Finished or detached async contexts cannot
  retain free admission.

## Batch responses and attribution

The existing `documents`, `succeeded` and `failed` fields remain. New fields:

- `deferred`: selected documents not attempted because admission stopped.
- `quotaLimited`: whether the batch stopped at the quota boundary.

A partially processed REST batch still returns HTTP **201** with these fields.
Remaining documents retain their prior queue state; they are not marked as
business failures or silently dropped. Owned partial runs are marked failed
with deferral metadata, not falsely succeeded. The Eve tool explicitly tells
the model the queue is not drained. An envelope refused before starting returns
HTTP **429**; tRPC uses `TOO_MANY_REQUESTS`.

REST forwards verified token subject, scopes and `runId` to commands. Signed
run IDs are retained in tRPC session context and command audit attribution.
Request-body scopes, run IDs and source flags cannot override verified claims.
Runs supplied by a caller remain caller-owned rather than being completed by
a nested batch.

Built-in token exchange, local bootstrap authentication, scheduler, event wakes
and IMAP use `AIPMS_AGENT_ID` (local fallback `agent-operator`), so changing entry
points no longer selects a fresh automation budget. Independently authenticated
agent users/token subjects have independent budgets. Quotas do not isolate data
ownership or provide a platform-wide budget across distinct principals.

## Deployment and rollout

Compose now forwards the API's rate/concurrency configuration and
`AIPMS_AGENT_SCOPES`. Its null scope mapping inherits shell/explicit env-file
values: unset retains application defaults; explicitly empty remains deny-all.
Choose least-privilege scopes. Preflight validates the numeric limits.

1. Stop old API/automation replicas; old command binaries bypass these checks.
2. Review configured principal identity, current agent User quotas and scopes.
   Legacy scheduler/wake/IMAP IDs no longer have separate active budgets.
   Existing counters/history are not rewritten; allow a minute boundary when
   coordinating the cutover.
3. Deploy consistent settings on participating API processes.
4. Check effective container settings and token scopes, then enable automation.
   Tune budgets for envelope + document costs, not just incoming HTTP requests.
5. Observe deferrals, failed agent runs and event dead letters.

**Concurrency is process-local**, deliberately preserving the deployment's
single-API-node contract. With N replicas the effective cap can be N times the
configured value. There is no PostgreSQL quota semaphore, expiring quota lease,
crash fencing, cluster-wide cap or provider exactly-once guarantee. A process
crash clears its local slots; persistent minute counts survive. Existing
automation/database leases still protect their own work but do not make quota
concurrency cluster-wide. Do not advertise multi-replica concurrency enforcement
without implementing and validating it separately.

Quota-throttled event wakes still use the relay's existing retry/dead-letter
policy; this milestone does **not** change its backoff or retry accounting.
A sustained low budget can dead-letter pending events before the next minute.
Scheduler/IMAP failures leave safe work pending. Operators must monitor, tune
and review retries; never reset ambiguous external dispatches to evade limits.
The bucket store still needs an operational retention/cleanup policy.

## Verification

- Database-blocked injected-client tests exercise strict configuration,
  authorization ordering, every command source, nesting, slot/error release,
  detached contexts, server-owned limits and fail-closed counter outages.
- Real PostgreSQL tests exercise atomic parallel first-hit increments across
  service instances and shared middleware/command accounting.
- Real HTTP/queue tests exercise REST/tRPC parity, per-document deferral,
  ownership/run attribution, stored overrides, scope refusals, a held command
  competing with HTTP, and actual scheduler/event-wake entry points.
- Compose configuration tests cover unset, explicitly empty and narrow scopes.
  Production-image smoke verifies non-default settings in the running API and
  admits one authenticated empty batch before requiring HTTP 429.

This evidence does not validate live SMTP/IMAP/LLM/IdP/bank/QBO behavior or
establish production financial, tax, legal or compliance readiness.
