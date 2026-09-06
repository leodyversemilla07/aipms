# Codebase review — 2026-09-06

AIPMS has a substantial procurement domain implementation, but the current code should not be treated as production-ready for procurement and payment operations. The main gaps are authorization, workflow invariants across multiple records, and reliable side effects. Passing lint and typechecks does not establish those properties.

This review covers the architecture, API authentication and domain services, database schema, agent runtime and automation, web desks and shared UI, ERP/messaging integrations, deployment, and test configuration. It is a broad source review with selected execution checks, not an exhaustive proof of every path. No application source was changed. No live bank, mail, identity-provider, or ERP integration was exercised, and tax-law correctness was not assessed.

## Architecture

| Area | Implementation | Assessment |
| --- | --- | --- |
| Web | Next.js 16.2.12, React 19, TanStack Query, tRPC, shared shadcn/Base UI components | Clear desk-oriented organization; client fetching and manually asserted response types weaken the end-to-end type contract. |
| API | NestJS 11, nestjs-trpc, Zod | Feature modules separate routers from domain services. Authorization and auditing mostly live in routers, which internal workers bypass. |
| Database | PostgreSQL, Prisma 7, migration history | Good use of transactions and row/advisory locks in several workflows. Many cross-domain identifiers have no database foreign key, leaving integrity entirely to application code. |
| Identity | Better Auth, SSO/SCIM, service bearer token | Human roles and machine scopes are distinct. Public enrollment and inconsistent human role gates undermine the intended enterprise boundary. |
| Automation | Eve tools plus API scheduler and event-driven workers | Multiple execution paths exist, with different identities, authorization, auditing, and failure handling. |
| Finance | Shared deterministic tax functions, invoice matching, payment snapshots, batch and ERP exports | Integer minor units and frozen beneficiary snapshots are good foundations. Several lifecycle and aggregation invariants remain incomplete. |
| Operations | pnpm/Turbo, Docker Compose, GitHub Actions, Vitest and Playwright | Useful automated checks and migration packaging; unsafe deployment defaults and incomplete restore isolation need attention. |

## Verification

| Check | Result |
| --- | --- |
| `pnpm check` | Passed; 316 files checked, no fixes applied. |
| `pnpm typecheck` | Passed; 9 tasks successful, 5 served from cache. |
| Agent tests | 55 passed across 6 files. |
| Tax tests | 7 passed. |
| Environment tests | 8 passed. |
| API tests | 5 files passed, 38 failed; 54 tests passed, 82 failed, 49 skipped. Database failures prevent interpreting this as a clean product regression result. |
| Read-only database probe | `ECONNREFUSED` for PostgreSQL at `localhost:5432`, database `aipms`. |
| Targeted tax calculation | Reproduced incorrect per-line tax results; details below. |
| Production builds, browser E2E, external services | Not run. Database-backed E2E validation remains outstanding. |

## High-priority findings

### 1. Public enrollment can reach vendor qualification changes

References: `packages/auth/src/auth.ts:42`, `apps/web/components/sign-in.tsx`, `apps/api/src/vendor/vendor.router.ts:103`.

Email/password enrollment is enabled, the UI exposes account creation, and vendor creation/update accepts `status` without a human role requirement. An ordinary newly registered user can change a blacklisted or prospective vendor to `active`, bypassing the separate qualification approval workflow. Authenticated reads also expose broad procurement and financial data, including full vendor records.

Restrict enrollment to the organization's provisioning/invitation policy and enforce explicit roles on sensitive master-data transitions. Test the full signup-to-mutation path as an ordinary user.

### 2. Agent quota middleware runs before the context it requires exists

References: `apps/api/src/trpc/trpc.module.ts:22`, `apps/api/src/trpc/middlewares/agent-quota.middleware.ts:97`, `apps/api/src/trpc/middlewares/auth.middleware.ts`.

Quota enforcement is global, whereas `AuthMiddleware` is attached to routers. The installed nestjs-trpc implementation applies global middleware first. `TrpcContext` provides a session but no `actorKind`; the quota middleware sees `actorKind !== 'agent'` and immediately passes through. Authentication only sets that field afterward. Existing quota tests construct an already-authenticated context and miss this ordering problem.

Run identity resolution before quota checks, then verify limits through the assembled tRPC stack.

### 3. Caller-selected template names bypass messaging approval

References: `apps/api/src/messaging/messaging.service.ts:181`, `apps/api/src/messaging/messaging.router.ts:25`, `apps/agent/agent/lib/vendor-message.ts`.

The server chooses `auto` solely from an allowlisted `templateId`, while accepting arbitrary caller-supplied subject and body. An agent can submit binding commercial language with `templateId: 'rfq'` and avoid human review. The more conservative quote helper does not protect the general messaging endpoint.

Render automatic messages from server-owned templates and validated parameters. Arbitrary text should remain gated. Currently the configured transport only logs, so this is an approval/state defect today and an external-send risk when a real transport is installed.

### 4. Invoice matching reuses the same PO and receipts for multiple invoices

Reference: `apps/api/src/invoice/invoice.service.ts:159`.

Each invoice is matched against the full PO total and full receipt value independently. There is no deduction or allocation for other invoices already matched or paid against that PO. Two different invoice numbers, each for the full order, can both match and become payable. The `(vendorId, number)` uniqueness constraint only prevents exact invoice-number duplicates.

Matching also does not check PO lifecycle or currency equality. Reserve invoice allocations against PO/receipt capacity under a shared transaction lock, and validate lifecycle/currency as part of that decision.

### 5. Duplicate lines within one receipt defeat the quantity cap

Reference: `apps/api/src/receipt/receipt.service.ts:126`.

The receipt loop compares every new line with historical quantities but never updates the accumulated quantity within the incoming request. For an order of 10 units and no prior receipts, two request lines for the same PO line at 6 units each both pass, recording 12 units. The router permits duplicate line numbers.

Aggregate incoming quantities per PO line before validating, or advance the running total after every accepted line. Validate consistency between `poLineId`, `lineNo`, and the actual order.

### 6. Receipt cancellation leaves invoices payable

References: `apps/api/src/receipt/receipt.service.ts:202`, `apps/api/src/invoice/invoice.service.ts:310`, `apps/api/src/payment-run/payment-run.service.ts`.

Cancelling a receipt changes only the receipt status. It does not invalidate invoices that matched using those goods. Payment planning trusts the stored `matched` status, so an invoice can still be planned after its supporting receipt is cancelled. Conversely, rematching only selects `received` invoices, so a receipt-shortfall exception does not automatically recover after the remaining goods arrive.

Make receipt corrections and invoice eligibility changes one coordinated transaction, with explicit rules for invoices already reserved in payment runs.

### 7. Approval decisions and PO cancellation are not safely serialized

References: `apps/api/src/approval/approval.service.ts:88`, `:108`, `:225`.

Approval state is read and then updated unconditionally. Concurrent decisions can both act on a pending approval. More directly, multiple cancellation requests can exist for one PO; approving each sets the PO to cancelled again and releases its budget commitment again. This can release commitment belonging to other orders sharing the budget. The budget release itself writes a value computed from an unlocked read, allowing lost updates against other budget mutations.

Use conditional approval transitions, lock the PO and budget in a consistent order, and release commitment only for the first valid PO transition. Requisition approval should also account for rejected sibling gates rather than only counting pending gates.

### 8. Voided and unsuccessful payment runs permanently retain invoice claims

References: `apps/api/src/payment-run/payment-run.service.ts:148`, `:391`, `packages/db/prisma/schema.prisma` (`PaymentRunLine`).

An invoice can appear in only one `PaymentRunLine` for its entire lifetime. Voiding a run preserves those lines, and creation rejects any existing claim without checking the owning run's status. Rejected/dishonored payments are similarly still claimed. Consequently, users cannot create a corrected replacement run through the supported workflow.

Represent active payment reservations separately from immutable payment history, or implement a controlled retry/claim-release model that preserves prior outcomes.

### 9. Payment reconciliation permits contradictory terminal outcomes

Reference: `apps/api/src/payment-run/payment-run.service.ts:344`.

The service checks the run outside the transaction and unconditionally changes a line's status. While another line remains pending, a previously paid line can be changed to rejected, but its invoice remains `paid`. Concurrent reconciliation of the last two lines can also leave the run `executed`: each transaction can count the other's uncommitted line as still pending.

Serialize reconciliation at the run, allow only valid line transitions, and update invoice state and run completion consistently. Correction of a terminal outcome needs an explicit audited operation.

### 10. QuickBooks export retries can post another journal before failing locally

Reference: `apps/api/src/erp/erp.router.ts:241`.

`qboPushExport` calls the external journal POST before checking/updating local acknowledgement. Repeating a successfully posted export can issue another POST and only afterward fail because the export is already posted. Concurrent calls and a crash between the POST and acknowledgement create the same gap. The request does not carry a stable external idempotency key.

Persist dispatch state, reject already-completed operations before sending, and use a supported provider idempotency/reconciliation strategy for ambiguous external outcomes.

### 11. ERP manifests stop working after payment reconciliation

References: `apps/api/src/erp/erp.service.ts:51`, `:187`.

Both export creation and viewing an existing manifest call a builder that accepts only `executed` runs. Once the payment run becomes `reconciled`, neither operation works. The reconciliation report nevertheless includes reconciled runs as requiring exports. In addition, manifests are rebuilt from mutable vendor names/tax IDs rather than stored as immutable export artifacts, so later master-data edits can break verification.

Permit the completed lifecycle state and persist the exact canonical export artifact at creation.

### 12. The bank verification UI saves fake, incompatible account data

References: `apps/web/components/master-data/vendors.tsx:157`, `apps/api/src/payment-run/batch.ts` (`parseBeneficiary`).

“Verify bank” writes `DEMO BANK`, a synthetic account number, and `accountName`, with no production guard or real account-entry workflow. The payment parser requires `holder`, so accounts created by this button appear verified in the UI but cannot produce valid beneficiary snapshots. The UI hides the button based solely on `bankAccountVerifiedAt`, ignoring the changed-account marker.

Replace this action with real account capture and verification. Share the account schema with the API, display verification/change status accurately, and isolate demo behavior explicitly.

## Additional correctness and operational findings

### 13. Per-line tax outputs are cumulative rather than per-line

Reference: `packages/tax/src/index.ts:88`.

The loop computes `lineVat` and `lineEwt`, but appends the running `vatMinor` and `ewtMinor` totals to every result row. Executed reproduction: two goods lines of 10,000 minor units each return VAT rows of 1,200 and 2,400, while the invoice VAT total is 2,400. Summing the rows yields 3,600. EWT has the same defect. Invoice-level totals are correct in this reproduction.

Return the line-specific variables and add an assertion that the sum of line amounts agrees with each reported total. All seven existing tax tests passed despite this defect.

### 14. Background automation does not share router safeguards or audit coverage

References: `apps/api/src/agent/agent-wake.service.ts:40`, `:139`, `:195`, `apps/api/src/agent/agent.scheduler.ts`, `apps/api/src/shared/audit/audit.service.ts`.

Wake handlers register unconditionally; `AGENT_AUTORUN=0` only disables the separate scheduler. Wake handlers call domain services directly, bypassing router machine scopes, quotas, and audit appends. Their exception handlers record a failed run but swallow the error, so the event relay can mark the event published instead of retrying/dead-lettering it. The audit writer also never persists `runId`, while analytics traces query by that field.

Use a shared authorized execution boundary for workers and interactive calls, propagate run identity, and distinguish retryable failures from completed business refusals.

### 15. Messaging send idempotency is weaker than its comments claim

References: `apps/api/src/messaging/messaging.service.ts:287`, `:362`, `apps/api/src/messaging/messaging.module.ts`.

The transport call occurs before the conditional database status update. Two callers can both read queued state and both send before one wins the update. Post-commit crashes can also strand approved messages, because there is no durable delivery worker for these rows. The configured transport is a stdout logger but transitions messages to `sent`.

Use a durable dispatcher with exclusive claims and provider-level idempotency where supported; distinguish simulated dispatch from actual delivery.

### 16. Restore leaves the API and its writers running

Reference: `scripts/restore.sh:21`.

The script stops web and agent but leaves the API running, including its event relay and optional ingestion/scheduler workers. Restoring a dump with drop/create statements can race those writers. The final `docker compose up -d` does not guarantee an already-running API restarts, so the documented migration-on-boot step is not guaranteed either.

Stop all writers before restore and explicitly restart the intended application image afterward. Test restoration against a disposable database.

### 17. Deployment defaults do not fail closed

Reference: `docker-compose.yml:20`, `:23`, `:51`.

The production compose service has a predictable default database password and auth secret, and publishes PostgreSQL on all host interfaces by default. Require production secrets explicitly and make database exposure opt-in or loopback-only. The untracked `aipms-ssh-key` filename is also not excluded by the current ignore rules; it was not read, and there is no evidence it is committed, but accidental staging should be prevented.

### 18. Other gaps worth scheduling

- Budget `spentMinor` is read in availability/analytics but has no update path in API source; payment settlement never moves committed amounts into actual spend.
- Sourcing awards do not feed selected vendor/prices into PO issuance, which copies requisition lines and accepts a separate vendor argument. Comparison also orders raw amounts without a currency check and uses a constant vendor rating in the best-value score.
- LLM provider policies parse retention/no-retention flags but do not enforce them. The offline host classifier rejects numeric loopback addresses and the documented Docker hostname `llm` unless separately allowlisted.
- Invoice, intake, payment-run, and quote lists have unbounded reads; some accept pagination-shaped router input but ignore it. Audit verification loads the entire chain. These paths need bounded query behavior as data grows.
- Web query state survives sign-out in a module-level QueryClient; sign-out actions do not clear it. Response types are repeatedly asserted through `as unknown as` (25 occurrences), hiding API contract changes from typechecking.
- Shared components exist, but desks duplicate navigation/session shells, raw form controls, notices, and status colors. Consolidating these would improve consistency and error handling.
- Vendor messaging requires `contactChannels.verifiedEmails`, but ordinary vendor create/update and the master-data UI do not provide a supported workflow to manage them.
- The test suite needs more cross-feature scenarios: signup-to-authorization, middleware order, duplicate receipt lines, multiple invoices per PO, cancellation after matching, replacement payment runs, concurrent reconciliation, and retrying external sends. Current tests often validate individual services with preconstructed context.

## Suggested implementation order

1. Close enrollment/role gaps, correct quota ordering, and make automatic messaging server-templated.
2. Repair PO/receipt/invoice allocation and cancellation invariants under consistent locks.
3. Implement recoverable payment reservations, terminal reconciliation rules, and durable ERP dispatch.
4. Replace demo bank verification, correct per-line tax output, and connect budget settlement and audit run traces.
5. Harden deployment/restore and run integration/E2E checks against an isolated PostgreSQL instance.

Keep the existing module boundaries, integer money model, scoped machine surface, atomic idempotency helper, beneficiary snapshots, and test infrastructure. They provide a useful basis for these fixes; a rewrite is not necessary to address the identified problems.
