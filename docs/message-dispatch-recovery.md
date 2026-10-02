# Durable outbound dispatch recovery

## Supported automatic recovery

The API's registered message dispatcher scans at most 25 oldest staged messages
every five seconds. It is enabled outside tests by default. Set
`AIPMS_MESSAGING_DISPATCHER_ENABLED=0` to pause **background** release; this does
not disable explicit post-commit releases or the transport. Invalid flag values
fail startup. Compose explicitly forwards the setting.

Only these rows may claim delivery:

- Auto-tier `queued` messages.
- `approved` messages with durable reviewer identity and approval time.
- No prior dispatch timestamp, sent timestamp, or provider receipt.
- No delivery resolution, or an independently authorized
  `confirmed_not_sent` resolution with retained evidence/resolver/time.

Selection alone grants no permission to send. Interactive callers and all API
replicas use the same claim. The service locks the message, conditionally
changes an eligible row to `sending`, locks its vendor, and checks the canonical
recipient/subject/body hash, current blacklist status, and current verified
recipient. Automatic rows also require supported versioned provenance and an
exact match with server-rendered canonical business facts; see
[automatic messaging](automatic-messaging.md) for legacy handling and template
contracts. Blocked content/contact/provenance checks retain a failed row without
contacting the provider. Those failures are not automatically replayed.

Message → vendor is the dispatch transaction's lock order. The transaction
commits **before** provider contact; no database lock is held across SMTP.
Contact eligibility is evaluated at that claim boundary. Revoking a contact
after a claim cannot recall an already authorized external send.

These rules recover crashes after submission, approval, or a confirmed
non-delivery recovery commits but before the caller releases the message.
Shutdown stops further selections/claims, but does not pretend to cancel an
in-flight provider operation.

## Ambiguous outcomes remain blocked

A crash after a durable claim can leave `sending`, whether or not the provider
accepted the message. Neither age, process restart, poll failure, nor SMTP error
authorizes an automatic retry. `failed` rows also require explicit provider
reconciliation. This is **not exactly-once delivery**.

The existing finance-only failed-delivery resolution requires evidence and a
resolver different from a gated message's approver. Confirmed delivery closes
the row without another send. Confirmed non-delivery stages one new eligible
claim, which either the caller or background dispatcher can release.

A supported stale-`sending` resolution workflow remains **open**. Do not reset
its status/timestamp manually. Quiescing the prior sender, provider evidence,
attempt identity/fencing, independent resolution, and audit/idempotency must be
designed together before exposing that command. Merely fencing database writes
would not stop an old worker from completing external delivery.

## Monitoring

The authenticated operations endpoint now includes:

- `staleStagedMessages`: auto queued or approved rows unchanged for 15 minutes.
  This includes inconsistent staged history that the dispatcher refuses to
  release. Unreviewed gated drafts do not count.
- `staleSendingMessages`: sending claims older than 15 minutes, plus sending
  rows with missing claim time.
- `ambiguousErpDispatches`: unresolved claimed exports with a dispatch failure,
  an age over 15 minutes, or a missing claim time. An abandoned QBO claim is
  visible even when the process never persisted an error.

Monitoring never mutates these rows. The fail-closed scheduled operations probe
checks both new message gauges with zero default thresholds. Deploy API and
probe together: an older API missing the gauges fails the new probe rather than
appearing healthy. The recovery desk's current failed-message action still
does not resolve `sending`; authorized operators can inspect those rows using
the additive `messaging.list` status filter.

## Regression evidence and limits

Database-blocked regressions cover eligibility, safe claim ordering, duplicate
callers under synthetic serialization, content/contact checks, ambiguous
failure retention, bounded polling, shutdown/reentrancy, and the gauge filters.
Synthetic serialization is not evidence of PostgreSQL row-lock semantics.

Twelve guarded PostgreSQL cases cover post-commit recovery, competing replicas
and callers, transaction visibility/rollback, stale and prior-attempt refusal,
dispatch-time integrity/contact checks, and committed non-delivery recovery.
They use injected transport receipts (no external delivery). CI runs them
against its disposable `*_test` database; local execution must satisfy the same
unchanged database guard.

Remaining work includes evidence-based stale-sending resolution, server-owned
canonical template parameters, transport-wide deadlines, provider/operator
reconciliation, and real deployment/provider validation.
