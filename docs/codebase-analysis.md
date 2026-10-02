# Current codebase analysis

## Scope and baseline

Reviewed source commit: `dddc7c85c0b53a69fbc116c278f4d879b2510730`.

This is a repository-wide architecture and risk review of the API, database model and migrations, agent runtime, web desks, shared packages, deployment scripts, and CI/release workflows. It is not an exhaustive line-by-line audit or proof of production readiness. The repository contains 483 tracked files, including 351 TypeScript/TSX/JavaScript-module/shell files. Generated code was inspected as a contract boundary, not reviewed as handwritten application logic.

The historical `docs/codebase-review.md` is explicitly a historical snapshot. Many of its findings have been remediated; copying its findings or test counts into a current assessment would be misleading.

The review itself did not change application source; subsequent fixes are tracked below. Synthetic runtime probes used fake records and injected clients; they did not query or mutate the development database. No live SMTP, IMAP, IdP, bank, or QuickBooks operation was performed. Legal/tax compliance and external service behavior were not independently certified.

## Follow-up remediation

The findings and baseline verification below describe the reviewed source commit, not the latest remediation state.

Completed in `942abf2fe2dc09b0dfe5dfa8b9c07bce4d72601b`:

- **Finding 1:** narrowed the audit page cursor explicitly. Full workspace typecheck now passes all nine tasks.
- **Finding 2:** shared agent projection now covers intake lists, detail, and all six mutation responses. Projection runs after idempotency so older cached raw outcomes cannot bypass it. Human payloads and persisted evidence remain unchanged.
- **Related audit bypass:** agent audit lists now return metadata with null `before`/`after` snapshots, preventing those reads from exposing raw intake or protected finance payloads. Authorized humans retain full snapshots.
- Added a database-blocked unit lane, enabled it in CI/release validation, and documented its isolation from the guarded integration suite.

Follow-up validation: 46 API unit tests across four files; 70 agent tests; seven tax tests; eight environment tests; full workspace typecheck; lint/format; new regression-file TypeScript checks; release/operations self-tests; and diff checks all passed. Seven new real-HTTP regression cases were added, but execution was blocked by the unchanged disposable-database guard. PostgreSQL integration/concurrency, browser E2E, production builds, and live-provider validation remain pending.

Financial correction follow-up:

- **Findings 3–4:** cancellation now refuses paid invoices/paid lines, live payment reservations, and recorded receipts. Supported cancellations invalidate stale matched invoices and release the unpaid PO's exact commitment from its authoritative budget link; inconsistent balances/links/currencies fail closed instead of being floored to zero. New planning also rechecks linked PO lifecycle, including stale legacy matches.
- **Finding 5:** a shared correction guard now locks all PO invoices before checking payment state. Planning uses the same ID ordering. Receipt correction also refuses paid obligations.
- Added 32 financial unit regressions (78 API unit tests total across six files) and nine PostgreSQL rollback/race cases. The PostgreSQL cases are typechecked but not executed locally; the unchanged database guard still blocks them, and Docker remains unavailable.

These source-level fixes do not establish production readiness. Per-PO settlement accounting, tolerance/partial-payment behavior, historical inconsistencies, and return/refund workflows remain open. See `docs/financial-corrections.md` for the supported correction contract.

Outbound dispatch follow-up:

- **Finding 6 (partial):** registered a bounded dispatcher for safely unsent
  auto queued and durably approved rows, using the same exclusive delivery claim
  as interactive releases. Prior dispatch history and ambiguous states are
  never automatically replayed.
- Delivery claims now validate canonical content integrity and current vendor
  blacklist/contact authorization before external transport.
- Operational gauges/probe now detect aged staged/sending messages and
  abandoned unresolved QBO claims even without a recorded failure. Authorized
  message lists accept the `sending` filter.
- Added 35 database-blocked regressions (116 API unit tests total) and 12 guarded
  PostgreSQL cases. The PostgreSQL cases are typechecked; local execution remains
  blocked by the disposable-database contract. CI provides the isolated runtime.
- Stale-sending operator resolution remains open; no unsafe manual reset or
  automatic retry was introduced. See [dispatch recovery](message-dispatch-recovery.md).

The earlier financial/HTTP validation limitation was removed **in CI** at
`80912129f68a8ce19bd3f1cd90206867fd7fb6b6`: 383 API tests, 20 browser tests,
and the production image/backup/restore smoke passed in run
[36851448070](https://github.com/leodyversemilla07/aipms/actions/runs/36851448070).
This does not imply local database availability or live-provider correctness.

Automatic message follow-up:

- **Finding 7:** automatic template identifiers are now restricted data tokens,
  resolved against canonical catalog/PO/receipt/invoice records. Delivery
  acknowledgements derive quantities and units from recorded receipts; invoice
  acknowledgement no longer falsely claims matching or payment state.
- Strict parameter schemas reject caller prose and extra fields. Free-form
  content continues to require review.
- New rows retain versioned source references, and the shared delivery claim
  rechecks exact canonical content before provider contact. Legacy automatic
  rows without provenance fail closed; metadata is not backfilled.
- Local validation passed 499 API tests on a newly provisioned disposable
  `*_test` database, including the real HTTP and PostgreSQL regressions; the
  owned test container/anonymous volume was then removed. The separate unit
  lane passed 173 tests, agent tests passed 71, and typecheck/lint/supporting
  environment/tax/demo/release/operations checks passed. No development/demo
  database was selected for integration tests and no live provider was contacted.
- See [automatic messaging](automatic-messaging.md) for the compatibility change,
  rollout/legacy handling, verification scope, and claim-boundary limitations.

## Executive assessment

**The architecture is worth preserving, but the current revision is not ready for production financial operations.** At the reviewed baseline, release blockers included a reproducible workspace typecheck failure, an agent data-projection bypass, and cancellation paths that are not coordinated with invoice eligibility and budget settlement. Additional risks concentrate around concurrency, dispatch recovery, and effective configuration.

The system is substantially stronger than the earlier review suggests:

- Human procedures have a centralized, default-deny role matrix.
- Ordinary requesters are restricted to their own requisitions.
- Agents have a separate default-deny capability map and five-minute signed bearers.
- Router authentication invokes quota enforcement after identity resolution.
- HTTP email signup and raw SSO/SCIM administration are disabled.
- Atomic idempotency commits domain writes, audit records, and result storage together.
- PO issuance, receipt allocation, invoice allocation, and payment reconciliation use transaction locks or conditional transitions.
- Beneficiary changes require two different finance principals, and payment runs freeze verified beneficiary snapshots.
- Message delivery and QBO posting claim durable state before contacting the provider.
- Tax line outputs are now per-line rather than cumulative.
- ERP manifests are stored as immutable artifacts for subsequent reads.
- Audit rows have append-only database protection and a hash chain.
- Restore validation, image digest pinning, signed image publication, and release evidence checks exist.

These are good foundations, not substitutes for validating the remaining cross-domain invariants.

## Architecture

| Area | Current structure | Assessment |
| --- | --- | --- |
| API | NestJS feature modules, nestjs-trpc routers, Zod inputs, domain services | Clear boundaries, but correctness spans multiple modules and cannot be established by router checks alone. |
| Web | Next.js App Router, React, TanStack Query/tRPC, shared shadcn/Base UI components | Shared shell and sign-out cache clearing are improvements. Several desks still expose only a capped first page. |
| Agent | Eve runtime plus deterministic API extraction, scheduler, and event wakes | These are distinct execution paths. Capability checks are shared more consistently than quotas, identities, policy selection, or run attribution. |
| Data | PostgreSQL, Prisma, explicit migrations, integer minor units | Useful locks and snapshots. Important cross-domain references remain plain strings without foreign keys. |
| Finance | Deterministic tax, PO/receipt/invoice matching, maker/checker payment runs, hand-off artifacts, ERP journal export | Strong local guards; cancellation and settlement accounting still need coordinated invariants. The application produces bank hand-off files, not a live bank execution integration. |
| Integrations | SMTP, IMAP, OIDC/SAML/SCIM, QBO OAuth and journal posting | Good seams and defensive defaults. Crash recovery and real-provider validation remain essential. |
| Operations | Docker Compose, three image targets, CI integration/E2E jobs, monitoring/release/backup scripts | More mature than a prototype, but effective container configuration and fail-closed restore behavior need attention. |

## Executed verification (review baseline)

| Check | Result |
| --- | --- |
| `pnpm check` | Passed; 382 files checked. |
| `pnpm typecheck` | **Failed** in `web#typecheck`: `apps/api/src/shared/audit/audit.service.ts(205,17): TS2532`, object possibly undefined. Eight other tasks succeeded. |
| `pnpm --filter agent test` | Passed: 70 tests, eight files. |
| `pnpm --filter tax test` | Passed: seven tests. |
| `pnpm --filter @workspace/env test` | Passed: eight tests. |
| `pnpm release:gate:test` | Passed. |
| `pnpm operations:check:test` | Passed. |
| Synthetic audit pagination probe | A valid 501-entry chain passed in two queries; tampering with entry 501 was detected. |
| Synthetic intake-list probe | Raw sensitive fields and attachment bodies were returned unchanged. |
| Synthetic PO-cancellation probe | Cancelling a fully paid PO removed another PO's remaining budget commitment. |
| Synthetic messaging-submit probe | Binding prose in an RFQ `sku` passed validation and produced an `auto` message. |
| Docker | Daemon unavailable. |
| PostgreSQL integration/API/E2E tests | Not run in this review; a disposable database was not available. |
| Production builds, dependency audit, and real-provider validation | Not run. |
| Deployment-preflight shell regressions | Not validated locally: Windows file-mode reporting prevents the POSIX permission checks from passing. Those security checks were not weakened. |

A previous API-only typecheck passing does not contradict the workspace failure: the web configuration enables `noUncheckedIndexedAccess` and follows the generated router's service types into API source.

## Priority findings

### 1. High — current workspace typecheck is broken

**Follow-up status:** resolved in `942abf2`; all nine workspace typecheck tasks pass.

Reference: `apps/api/src/shared/audit/audit.service.ts:205`.

The new keyset verifier assigns `lastSeq = entries[entries.length - 1].seq`. The web compiler treats the indexed element as possibly undefined even after the length check. This was reproduced by the repository's actual `pnpm typecheck` command. It is a regression in the recent audit pagination change, not a pre-existing environment warning.

**Action:** Narrow the last element explicitly and run the full workspace typecheck, not only `api` or `agent` checks. Align compiler strictness across packages or add a contract-consumer check to the local validation checklist.

### 2. High — agent-safe intake redaction can be bypassed through list reads

**Follow-up status:** resolved in `942abf2` for intake list/detail/mutation responses, including cached outcomes. Related raw audit snapshots are also withheld from agents. Real-HTTP integration coverage is added but still awaits a disposable database.

References: `apps/api/src/intake/intake.router.ts:79`, `:84`; `apps/api/src/intake/intake.service.ts:145`; `apps/api/src/trpc/agent-capabilities.ts` (`intake.list`).

`intake.detail` branches on `actorKind` and redacts raw/classified values for agents. `intake.list` returns the service's full rows without an actor-aware projection; the underlying query has no restrictive select. Agents with the default `intake.read` capability can therefore obtain raw attachments, payment fields, and other data that the detail endpoint intentionally withholds.

The shipped list tool currently formats only identifiers/statuses, so this is not proof that its standard output uploads those fields to a model. It is still an API authorization/projection bypass: the machine caller receives the full raw response and can call the endpoint directly.

**Action:** Enforce a shared agent-safe DTO on all intake reads and mutation responses, not only detail. Prefer list metadata over fetching raw payloads. Add HTTP-boundary tests for list/detail and replayed idempotent results.

### 3. High — PO cancellation leaves matched invoices and live payment runs eligible

**Follow-up status:** supported cancellation now refuses live payment claims/paid obligations and recorded receipts, and invalidates stale matched invoices atomically. New planning rejects missing/non-live linked POs even with a stale match. PostgreSQL rollback/race validation and reconciliation of older inconsistent runs remain pending.

References: `apps/api/src/approval/approval.service.ts:126–175`; `apps/api/src/payment-run/payment-run.service.ts:110–122`, `:224–278`; `apps/api/src/receipt/receipt.service.ts:235–253`.

The PO-cancellation approval changes the PO status and releases its budget, but does not reevaluate matched invoices or check live payment claims. Payment-run creation trusts stored invoice status, and approval/execution only check run lifecycle. Thus an invoice previously matched to a now-cancelled PO can remain payable. A pre-existing draft/approved run is not invalidated either.

Receipt cancellation already has a dependent-invoice/payment-claim check; PO cancellation needs the same cross-domain discipline.

**Action:** Define cancellation rules for received, invoiced, reserved, executed, and paid orders. Block incompatible cancellation, or atomically compensate invoice eligibility and reservations under a consistent lock order. Revalidate eligibility before financial approval/execution as appropriate.

### 4. High — cancelling a paid PO can release unrelated budget commitments

**Follow-up status:** the paid-order over-release path is blocked, and unpaid cancellation uses an exact decrement with fail-closed budget-link, currency, and balance checks. The per-PO commitment/settlement ledger and broader settlement-variance accounting are not implemented by this fix.

References: `apps/api/src/payment-run/payment-run.service.ts:431–474`; `apps/api/src/approval/approval.service.ts:160`, `:268–289`.

Payment settlement subtracts the invoice's base amount from `committedMinor` and increments `spentMinor`. Later PO cancellation subtracts the entire PO total from the same shared committed balance, without tracking the PO's remaining commitment.

Synthetic reproduction using the real cancellation service:

- PO A total/base spend: 100,000 minor units, already paid.
- Shared budget: `spentMinor=100000`, `committedMinor=60000` belonging to PO B.
- Cancel PO A: the result is `committedMinor=0`.

The floor at zero hides the over-release; it does not preserve the other order's commitment.

**Action:** Introduce per-PO commitment accounting or a reservation/settlement ledger. Release only the unconsumed commitment, and forbid or explicitly compensate cancellation of paid/executed obligations. Add paid-PO-plus-other-PO tests.

### 5. High — receipt cancellation and payment planning do not share a serialization boundary

**Follow-up status:** correction now locks all PO invoices before payment checks and holds them through reevaluation. Planning locks overlapping invoice IDs in the same order. Synthetic ordering tests pass; deterministic PostgreSQL race cases are added but remain unexecuted locally.

References: `apps/api/src/receipt/receipt.service.ts:246–253`; `apps/api/src/invoice/invoice.service.ts:497–560`; `apps/api/src/payment-run/payment-run.service.ts:99–167`.

Payment planning locks invoices before checking their status and inserting claims. Receipt cancellation locks the PO, reads matched invoices, checks for claims, and only later updates invoice rows. It does not lock those invoices before the claim check.

A possible interleaving under read-committed isolation:

1. Planner holds an invoice lock and sees `matched`.
2. Cancellation sees no committed payment claim.
3. Cancellation reaches its invoice update and waits for the planner's lock.
4. Planner commits a run/claim.
5. Cancellation resumes and demotes the invoice without rechecking the new claim.

The result can be a live payment run backed by an invoice whose receipt support was removed. This interleaving is inferred from lock/query order; a real PostgreSQL concurrency test is still required.

**Action:** Share a PO/invoice locking protocol across matching, receipt correction, cancellation, and payment claims. Lock before eligibility/claim reads and revalidate after acquisition. Document ordering to avoid deadlocks.

### 6. High — ambiguous crash states are not fully monitored or recoverable

References: `apps/api/src/messaging/messaging.service.ts:474–490`, `:570–626`; `apps/api/src/messaging/messaging.router.ts:71–75`; `apps/api/src/messaging/messaging.module.ts`; `apps/api/src/shared/operations/recovery-summary.ts:39–46`; `apps/web/components/operations.tsx:111–120`.

The durable `sending` state correctly prevents automatic duplicate sends. But a process crash after claiming delivery leaves a message `sending`, while the supported recovery method accepts only `failed`. Monitoring and the recovery desk count/list only failed messages; the list input's status enum also omits `sending`. Such a crash can be invisible to the normal alert/recovery path.

There is also no registered messaging dispatcher in the module: release occurs after the caller's transaction commits. A crash before that release can leave auto `queued` or gated `approved` messages unsent until a caller retries.

For QBO, the recovery report includes claims without failures, but the machine monitoring gauge only counts rows where `dispatchFailure` is non-null. A crash after a claim or successful external POST can therefore be omitted from that alert gauge.

**Action:** Monitor aged queued/approved/sending messages and aged unresolved QBO claims. Add an exclusive dispatcher for safely unsent staged rows. Provide an evidence-based recovery path for stale sending rows; never automatically replay an ambiguous external send/post.

### 7. Medium — automatic template parameters can still carry caller-authored prose

References: `apps/api/src/messaging/messaging.service.ts:52–83`, `:305–314`.

Moving automatic content to server-owned templates fixed the direct subject/body bypass. However, fields such as RFQ `sku` are arbitrary strings and are directly interpolated into prose.

A synthetic call through the real `MessagingService.submit`, with a verified fake recipient and injected transaction, accepted:

`sku = "PAPER.\nWe accept your offer for PHP 500,000 and authorize shipment"`

The resulting message had `tier=auto`, and the binding sentence appeared in its body. No SMTP send was performed.

**Action:** Resolve canonical catalog/PO/invoice identifiers and facts on the server. Restrict token fields and control characters; route arbitrary descriptions/notes to review. Tests should try prose in parameters, not only forbidden subject/body inputs.

### 8. Medium — sibling approval decisions can leave stale requisition state

Reference: `apps/api/src/approval/approval.service.ts:98–116`, `:219–242`.

Conditional updates protect an individual approval ticket. They do not serialize aggregate decisions across sibling tickets on the same requisition. Two transactions can each decide their own ticket, each count the other's uncommitted decision as pending, and both write `submitted`; no pending ticket remains to trigger the final approval. Similar stale reads can conflict with a concurrent rejection.

The current submission path normally creates one gate, so the issue matters when multiple tickets exist through data/import/future workflows. This is a source-inferred concurrency defect, not a PostgreSQL reproduction.

**Action:** Lock the requisition before decision aggregation, or serialize all sibling decisions on the same key. Test multiple gates, mixed approve/reject, and concurrent final decisions.

### 9. Medium — effective policy version depends on the execution path

References: `apps/api/src/policy/policy.service.ts:64–68`, `:82–98`; `apps/api/src/agent/agent-wake.service.ts:84–86`, `:133–135`.

Interactive submission selects the highest enabled policy version. Event-wake automation uses unordered `findFirst` for threshold and preferred-vendor policies. Creating a replacement does not disable the prior policy, so automation can use an older threshold or vendor configuration. Policy creation also permits duplicate version numbers and cross-kind supersedes references.

**Action:** Use one policy resolver with explicit scope/precedence and deterministic ordering. Validate kind-specific configuration and same-kind supersession. Serialize version assignment or enforce appropriate unique constraints. Test old permissive/new restrictive policies through both interactive and wake paths.

### 10. Medium — quota protection is not shared by all agent execution paths

References: `apps/api/src/trpc/middlewares/auth.middleware.ts`; `apps/api/src/trpc/middlewares/agent-quota.middleware.ts`; `apps/api/src/agent/agent-command.service.ts:239–251`; `apps/api/src/agent/agent.controller.ts:68–83`.

The tRPC path correctly enforces quotas after authentication. The shared command service checks capabilities but does not invoke quota enforcement. REST batch, scheduler, and event wakes can therefore execute mutations outside the same per-principal rate/concurrency budget. A REST batch may process up to 100 documents without tRPC mutation accounting.

The REST guard does check `invoice.ingest`; this finding is about quota parity, not a demonstrated scope escalation. The controller also does not forward token scopes/runId to the command actor, weakening consistency and attribution.

**Action:** Centralize quota acquisition around authorized commands, with explicit rules for human/manual operations and per-document work. Propagate bearer identity, scopes, and run attribution. Define and test the deployment's multi-replica concurrency contract.

### 11. Medium — Compose ignores some documented security configuration

References: `docker-compose.yml:41–94`; `README.md` environment-variable table; `.env.example:187–188`; `apps/api/src/trpc/agent-capabilities.ts`.

The API container environment does not forward `AIPMS_AGENT_SCOPES`, `AIPMS_AGENT_RATE_LIMIT`, or `AIPMS_AGENT_CONCURRENCY`. Values placed in the root `.env` are not automatically injected into a container unless Compose maps them. The image does not copy the root `.env`.

An operator using the documented scope override can therefore retain default grants in the standard deployment. PO signing variables and key mounts similarly require an explicit deployment override rather than just the example environment values.

**Action:** Map supported configuration into the correct container and document required mounts. Validate effective configuration in the running image, especially empty scope sets and low quota settings. Test host-file configuration versus actual container values.

### 12. Medium — verified vendor contact enrollment is missing

References: `apps/api/src/vendor/vendor.router.ts:40–60`; `apps/api/src/vendor/vendor.service.ts:178–218`; `apps/api/src/messaging/messaging.service.ts:279–292`.

Outbound messaging requires `contactChannels.verifiedEmails`, but normal vendor create/update inputs and the master-data workflow do not provide a verification/enrollment operation. A newly created production vendor cannot use the advertised controlled messaging path without out-of-band database changes or an external setup mechanism.

**Action:** Implement an auditable verified-contact workflow with clear authority, verification evidence, normalization, and change invalidation. Add a create-vendor-to-message end-to-end scenario that does not seed verified contacts directly in the database.

## Additional improvements and limitations

### Finance and data integrity

- Partial invoicing is not fully represented by the matching model: the first amount gate compares each invoice to the full PO total. Allocation guards prevent double use, but do not alone establish a supported installment/split-invoice workflow. Document whether this is intentionally out of scope.
- Quote `validUntil` is stored but not used to exclude expired offers in comparison/award. Validate commercial expiry before award and PO issue.
- Invoice/vendor, invoice/PO, payment-line/invoice, receipt/PO, approval/PO/vendor, and PO/requisition references are largely plain strings. Add foreign keys and deliberate deletion policies where historical preservation permits them.
- Repeated export creation still rebuilds from current vendor metadata before checking the existing frozen artifact. Reading an artifact is stable; re-export behavior can conflict after a rename. Existing exports should have clearly specified replay behavior.
- QBO acknowledgement checks claim state before a conditional update whose predicate only checks status. Review races between claim creation and manual acknowledgement; include the observed claim in the update predicate or use a common lock.
- Tax policy input is untyped JSON. VAT normalization does not enforce integer/bounded basis points, and EWT rates are merged without comparable normalization. Persistence guards prevent some bad monetary results, but invalid policy data should be rejected when authored, not while registering invoices.
- BIR reports group invoice tax by receipt date without filtering lifecycle status. Whether that is the correct statutory recognition basis requires finance/legal review; this review does not assert a legal rule.

### Agent runtime and privacy

- The offline provider gate is a hostname/configuration check, not a network firewall or proof of no retention. Default Compose networking does not itself enforce zero egress. Treat network isolation, DNS, model-server logs, and runtime traces as deployment evidence.
- HTTP calls from the Eve client and QBO client should have explicit deadlines and controlled retries. External POST retry rules must respect ambiguous outcomes.
- Event-wake PO issuance can commit a PO and crash before marking its run succeeded. Retrying then encounters an already-issued PO instead of recovering the committed command result; a durable business result keyed to event/run would improve recoverability.
- The deterministic API extractor is not an OCR implementation. Preserve the existing human-review fallback for binary/unusable documents rather than claiming complete document automation.

### Frontend and scale

- Payment-run and matched-invoice selectors request default first pages with no page controls. Intake and several master-data/procurement views request only fixed first pages. Server-side limits improve safety but can make older records unreachable in the UI.
- List sorting often lacks an ID tie-breaker. Add stable ordering and ensure supported search/sort inputs are actually honored.
- Remaining broad reads include the requisition exception queue, policy history, run traces, certificate details, and IMAP vendor loading. Prioritize aggregation, bounded queries, and asynchronous exports where complete data is needed.
- Add indexes matching query patterns, particularly PO requisition lookup and status/date ordering. Validate with representative query plans instead of assuming single-column indexes suffice.
- Standardize error/empty/pending states and replace hand-maintained response assertions with shared/inferred DTOs where practical.
- Production CSP still allows inline scripts. A nonce/hash-based policy could improve XSS defense, but needs correct Next.js rendering/caching integration; do not simply remove the directive and break the app.

### Audit, deployment, and tests

- Bounded audit pages fix memory usage, not total scan cost or snapshot semantics. Capture a verification high-water sequence or use a consistent snapshot so concurrent appends do not extend the operation indefinitely.
- A hash chain without an independently stored head/checkpoint cannot prove that the tail was not truncated or the entire history rewritten by a sufficiently privileged actor. Embedded-key PO verification proves cryptographic consistency with that key, not external signer trust or legally qualified status. Keep claims aligned with this threat model.
- `scripts/restore.sh:83` ignores failure to stop writers with `|| true`. A failed stop must not silently proceed to destructive restoration; verify writers are stopped and abort otherwise.
- Docker runtime targets retain the full workspace/development dependencies and do not specify a non-root user. Reduce runtime contents and privileges while preserving required migration/runtime functionality.
- Rate-limit and idempotency storage need an explicit retention/cleanup policy. Persistent per-minute agent buckets can accumulate indefinitely.
- API integration isolation is good. The local browser suite reuses running servers and lacks the same explicit disposable-database guard; establish a similarly safe E2E contract.
- Most important missing tests are cross-domain concurrency/crash scenarios, not additional happy-path unit tests: PO cancellation versus payment, receipt cancellation versus planning, sibling approvals, crash-after-dispatch-claim, raw agent list projection, versioned wake policies, and effective Compose scope overrides.

## Recommended development sequence

1. **Restore a green workspace baseline:** fix the indexed-access type error; run lint, full typecheck, and isolated CI/integration tests.
2. **Close the privacy and cancellation blockers:** shared intake projection; PO cancellation/payment eligibility; per-PO budget commitments; common receipt/payment locking.
3. **Complete durable recovery:** safely dispatch staged unsent messages; detect/reconcile stale sending and QBO claims; recover event commands after post-commit crashes.
4. **Unify controls:** effective container scopes/quotas, command-level accounting, deterministic policy resolution, canonical message parameters.
5. **Complete product workflows:** verified contacts, expired quote handling, usable pagination/selectors, supported partial-invoice rules.
6. **Validate production operation:** disposable PostgreSQL race tests, browser E2E, image smoke, provider staging evidence, off-host backup restore, and finance/legal review.

A rewrite is not recommended. Keep the feature modules, deterministic money/tax engine, capability maps, atomic idempotency, beneficiary snapshots, transactional outbox, and immutable export artifacts. Concentrate changes on shared invariants and validate them through the assembled system.
