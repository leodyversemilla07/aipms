# AIPMS — AI-Native Procurement Management System

[![CI](https://github.com/leodyversemilla07/aipms/actions/workflows/ci.yml/badge.svg)](https://github.com/leodyversemilla07/aipms/actions/workflows/ci.yml)

**Status:** Unreleased production-hardening release candidate | **Deployment:** Single-tenant, self-hostable | **Runtime:** NestJS + tRPC + Next.js + eve

---

## What is AIPMS?

AIPMS is a **procurement management system where AI agents are the primary users**. Unlike traditional PMS tools that put humans in charge of every step, AIPMS flips the model:

- **Agents prepare routine procurement workflows** from requisitions through sourcing, POs, receipts, and invoice matching
- **Humans supervise and retain protected decisions** including approvals, quote awards, signatures, beneficiary verification, and payment execution
- **Every action is attributable and auditable; external effects are durably recoverable without unsafe automatic replay**

The system is designed for enterprise organizations that need:
- Automated procurement of routine purchases within budget/policy guardrails
- Human approval gates for high-value or exceptional transactions
- Full audit trail for compliance

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Web UI        │     │   Eve Agent     │
│  (Next.js 16)   │     │ (Larry Couderc) │
│  Supervisory    │     │                 │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │   tRPC      │  ← Primary API surface (typed, versioned)
              │  (v11)      │
              └──────┬──────┘
                     │
              ┌──────▼──────┐
              │   NestJS    │
              │  Auth: M2M  │  ← Better Auth for humans
              │  Bearer: agent │  ← Five-minute scoped tokens for agents
              └──────┬──────┘
                     │
              ┌──────▼──────┐
              │   Postgres  │  ← Prisma 7 database
              │   Prisma    │
              └─────────────┘
```

---

## Monorepo Structure

```
aipms/
├── apps/
│   ├── api/           ← NestJS + tRPC backend
│   │   ├── src/      ← Controllers, services, modules
│   │   └── test/     ← API specs (feature-named)
│   ├── web/           ← Next.js 16 supervisory cockpit
│   │   └── app/      ← Pages (/, /finance, /procurement, etc.)
│   └── agent/         ← Eve runtime for procurement agents
├── packages/
│   ├── auth/          ← Better Auth (human + service tokens)
│   ├── db/            ← Prisma schema + seed
│   ├── env/           ← Environment loading
│   ├── tax/           ← Tax engine (VAT, EWT, PH rules)
│   ├── ui/            ← shadcn/ui base-rhea components
│   └── typescript-config/
├── packages/db/prisma/schema.prisma   ← Data model
├── docker-compose.yml                 ← PostgreSQL + everything
└── README.md
```

---

## Key Features

### §6 Agents First
- Agents have identities, sessions, scopes, and quotas (same as humans)
- Scoped capabilities: `catalog.read`, `po.issue`, `invoice.match`, etc. — default-deny capability map on the M2M surface
- Quotas enforced in tRPC middleware: per-agent mutation rate + concurrency caps (`AIPMS_AGENT_RATE_LIMIT`, `AIPMS_AGENT_CONCURRENCY`)
- Graduated topology: operator agent today; specialist agents share one domain model

### §9 Data Model
- Financial values: `{ minorUnits: int, currency: string }` (PH-first: PHP)
- Money represented as integers to avoid floating-point errors
- Tax engine deterministic: VAT 12%, EWT 1%/2%/5% based on vendor type

### §10 Human-in-the-Loop
- Gates at risk points (approval, budget, vendor qualification)
- Exception queue for blocked actions
- Revision history for all changes

PO/receipt cancellation refuses paid obligations and live payment reservations;
recorded receipts must be resolved before PO cancellation. See
[`docs/financial-corrections.md`](docs/financial-corrections.md) for the workflow,
locking contract, and remaining accounting limitations.

### §11 Policy Engine
- Declarative, machine-checkable rules
- Configuration over code: thresholds, approval chains, blacklists as data
- Evaluated in-transaction, not after

### §12 Audit Trail
- Immutable `AuditEntry` records (append-only)
- Every action attributed to human or agent
- `runId` links agent execution to outcomes

### §14 Observability & ERP sync
- Hash-chained, tamper-evident audit trail with verification endpoint
- Agent run history on the supervisory desk (`agent.runs`)
- Governed journal export per payment run: balanced posting manifest,
  sha256-verified, ERP-importable JSON/CSV
- QuickBooks Online connector (OAuth2, encrypted tokens, chart mapping,
  push → acknowledge loop) as the §8.5 v1 anchor adapter
- Reconciliation gate surfaces un-exported runs and unacknowledged feeds
  instead of letting them drift silently

---

## API Surface (tRPC Routers)

| Router | Procedures | Purpose |
|--------|-----------|---------|
| `users` | me | Current user session |
| `catalog` | list, create | Catalog items for sourcing |
| `vendor` | list, create, verifyBankAccount | Vendor management |
| `requisition` | create, submit, list | Purchase requests |
| `sourcing` | request, receive, compare, award, list, detail | §8.1 structured quotes — RFQ → offer → deterministic award |
| `approval` | request, decide, list | Approval gates |
| `purchase-order` | issue, confirm, cancel, list | PO lifecycle |
| `intake` | ingest, classify, list | Document queue |
| `invoice` | register, list | Invoice matching |
| `agent` | process, batch | Agent tools (eve → API) |
| `audit` | list, meta | Audit trail |
| `policy` | list, create, taxConfig | Policy engine |
| `budget` | read, list | Budget tracking |
| `payment-run` | list, create, approve, execute, batch | Payment workflow (§8.6 PESONet hand-off file) |
| `messaging` | submit, approve, reject, list, detail | §8.3 vendor messaging relay (tiered sends) |
| `receipt` | record, cancel, list, detail | §8.1 goods receipts (3-way match leg) |
| `bir` | certificate, remittance, periods | §8.4 BIR statutory withholding reports |
| `erp` | exportRun, list, manifest, acknowledge, ingestVendors, reconcileReport, qbo* | §8.5 ERP bridge — journal exports, ack feed, QuickBooks connector |

**Total:** 104 procedures across 21 routers

---

## Web Desks

| Desk | Route | Purpose |
|------|-------|---------|
| Supervisory | `/` | Overview dashboard |
| Finance | `/finance` | Invoice register, payment runs, BIR 2307/1601-E reports |
| Procurement | `/procurement` | POs from requisitions, goods receipts, vendor messaging approvals |
| Intake | `/intake` | Email/EDI invoice queue |
| Audit | `/audit` | Event trail viewer |
| Master-data | `/master-data` | Vendors, catalog, budgets, policies |

---

## Getting Started

### Isolated local demo (recommended)

Prerequisites: Node.js **24.x**, pnpm **12.7.0**, Docker and its Compose plugin.
Start Docker Desktop's Linux engine on Windows.

From the repository root:

```sh
pnpm demo:setup
```

This creates a separate ignored `.env.demo` and an owned loopback PostgreSQL
database on port **55433**, installs frozen dependencies, generates Prisma,
applies migrations, then seeds master data. Existing root env files and
non-demo databases are not selected or reset.

Start these in separate terminals, then open http://localhost:3000:

```sh
pnpm demo:api
pnpm demo:web
```

Check availability with `pnpm demo:status`. Demo sign-in:
`maker@demo.aipms` / `demo-maker-123`, and
`checker@demo.aipms` / `demo-checker-123`. These identities are local-only.
The agent, unattended automation and real email are not enabled.

Follow [the guided procurement-to-payment demo](docs/local-demo.md), including
matching, independent payment approval, simulated hand-off/reconciliation,
ERP export and audit checks. Stop the app terminals and use `pnpm demo:stop`
to stop PostgreSQL while preserving its volume.

### Custom development environment

For an independently configured root `.env` and PostgreSQL, run
`pnpm install --frozen-lockfile`, `pnpm db:generate`, `pnpm db:deploy`,
and only then `pnpm db:seed`. Start API/web separately with
`pnpm --filter api dev` / `pnpm --filter web dev`.
The deployment Compose file requires its complete deployment environment even
when selecting only PostgreSQL; it is not the minimal local-demo bootstrap.

For local agent development without an API key, set `AIPMS_LLM_KIND=chatgpt`,
start `pnpm --filter agent dev`, then sign in through eve `/login`.
This mode is rejected in production or when `AIPMS_LLM_GATE` is set;
deployments use cloud or offline provider-gated modes.

Seed master data includes budget IT-PROD / 2026-01 (₱5,000,000), Acme Office
Supplies with a fictional verified bank account, two catalog items, and a
₱50,000 requisition threshold. For custom local demo identities, set
`AUTH_SEED_DEMO=1`; they are never seeded in production.

---

## Enterprise Deployment

Compose binds PostgreSQL, API, and web host ports to `127.0.0.1` by default. Put a TLS-terminating reverse proxy with request-size, timeout, and rate limits in front of the web service; browser API/auth traffic is proxied internally by Next.js. Change `WEB_BIND_ADDRESS` or `API_BIND_ADDRESS` only for an intentional firewalled network path—never to bypass TLS or authentication.

Validate a restricted deployment environment file before starting containers:

```bash
pnpm deployment:preflight -- /secure/path/production.env
```

### Backup & restore (§16.2.1)

```bash
# One-off or cron-scheduled logical dump (keeps last 14 by default)
./scripts/backup.sh /var/backups/aipms        # AIPMS_BACKUP_KEEP=30 to override

# Alertable freshness and integrity check
./scripts/backup-health.sh /var/backups/aipms

# Rollback: stop writers, validate, load a dump, then migrate and restart
./scripts/restore.sh backups/aipms-20260825-020000.sql.gz
```

Backups are published atomically with a SHA-256 sidecar. Restore verifies the checksum and loads the full SQL stream into a disposable validation database before touching the target. It then stops every application writer, terminates stale target sessions, restores in one database transaction, validates the migration ledger, and force-recreates the API so `prisma migrate deploy` runs before dependants restart. A failed target restore rolls back and leaves writers stopped for investigation. See [`docs/disaster-recovery.md`](docs/disaster-recovery.md) for monitoring and the staging drill procedure.

### Production image smoke test

Build all deployment targets, start an isolated PostgreSQL/API/web stack, apply migrations, verify the production health surfaces, run a read-only concurrency regression, and prove a backup/restore round trip with a disposable data probe:

```bash
./scripts/production-smoke.sh
```

The script uses dedicated default host ports (`3100`, `3101`, and `55432`) and removes its containers and volume when it exits. Tagged releases publish multi-architecture, immutable-digest images with SBOMs, build provenance, and keyless Sigstore signatures that are verified before the workflow completes. See [`docs/capacity-testing.md`](docs/capacity-testing.md) for the production-safe probe and staging protocol.

### Health and monitoring

- `GET /health/live` confirms that the API process is running without touching dependencies.
- `GET /health/ready` verifies PostgreSQL connectivity and returns HTTP 503 while the instance must be removed from load-balancer rotation.
- `GET /health/operations` returns authenticated, low-cardinality exception counters for dead letters, stale claims/runs, failed messaging, and ambiguous ERP dispatches. Supply `Authorization: Bearer $OPERATIONS_MONITORING_TOKEN`.
- `GET /health` remains a compatibility alias for readiness.

See [`docs/operations-monitoring.md`](docs/operations-monitoring.md) for alert thresholds and response ownership, and [`docs/staging-validation.md`](docs/staging-validation.md) for TLS, security-header, identity, integration, and secret-rotation release checks.

### Single-tenant, Self-hostable

AIPMS is designed for **enterprise-only** deployment:

- Docker Compose for production
- Environment configured via `.env`
- PostgreSQL runs in container or externally managed
- Agent runtime can point to local/offline LLM endpoint

### Security

- Better Auth with session + bearer tokens
- Short-lived scoped agent bearers issued through an authenticated bootstrap exchange
- Hash-chained audit trail with database-enforced append-only rows
- Maker/checker separation for approvals, PO signatures, beneficiary changes,
  payment-run overrides, and ambiguous ERP dispatch resolution
- Idempotency keys on retryable commands; durable claims for ambiguous external effects

### Configuration

Key environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Auth signing key |
| `AIPMS_TOKEN_ENCRYPTION_SECRET` | Independent AES-GCM envelope key for ERP credentials |
| `AIPMS_SERVICE_TOKEN` | Bootstrap credential for the agent token exchange and service API |
| `AIPMS_AGENT_SIGNING_SECRET` | Independent key for five-minute scoped agent bearers |
| `OPERATIONS_MONITORING_TOKEN` | Dedicated read-only token for operational exception gauges |
| `AIPMS_SMTP_HOST` / `AIPMS_SMTP_FROM` | TLS SMTP relay used for real vendor-message delivery |
| `AUTH_SEED_DEMO` | Seed demo users (maker/checker) |
| `AGENT_AUTORUN` | Enable the unattended intake drain loop |
| `AIPMS_AGENT_WAKE` | Enable event-driven agent wakes |
| `AIPMS_AGENT_SCOPES` | Replace default automation grants; explicitly empty denies all (forwarded by Compose) |
| `AIPMS_AGENT_RATE_LIMIT` | Shared admissions/minute per agent, default 60; batch envelope + each document |
| `AIPMS_AGENT_CONCURRENCY` | Root commands in flight per agent **per API process**, default 4 |
| `AUTOMATION_LEASE_TIMEOUT_MS` | Cross-replica scheduler lease timeout |
| `EVENT_RELAY_CLAIM_TTL_MS` | Recovery window for abandoned outbox claims |

---

## API Documentation

The tRPC API is the primary interface. Generated TypeScript client is available:

```typescript
import { createTRPCReact } from "@trpc/react-query"
import type { AppRouter } from "@workspace/api/src/generated/server"

export const trpc = createTRPCReact<AppRouter>()
```

Retryable domain mutations use idempotency keys. External QBO and messaging effects use durable dispatch claims and evidence-based reconciliation instead of unsafe automatic retries. Credential rotation and OAuth administration remain deliberate non-replayable operations. Agent actions are auditable with `actorKind: 'agent'`.

---

## Agent Development

The agent (`apps/agent`) runs on the eve framework. See `apps/agent/AGENTS.md` for details.

### Tool Surface

The eve agent uses a default-deny tRPC tool surface. Intake tools include:
- `list_intake` and `get_intake_document` — inspect bounded, prompt-safe projections; payment credentials and binary bodies are omitted server-side
- `classify_document` and `register_invoice` — persist a validated invoice payload and run deterministic tax/matching logic
- `agent.process({ id, idempotencyKey })` and `agent.batch({ limit })` — process deterministic structured intake only

Text, JSON, XML, and CSV email attachments receive bounded UTF-8 projections. PDF/image invoices require the configured OCR integration or human review; agents must not infer missing content.

### Agent machine authentication

The production agent exchanges its bootstrap secret for a scoped bearer that
expires after five minutes. Generate independent bootstrap and signing secrets:

```bash
AIPMS_SERVICE_TOKEN="$(openssl rand -base64 32)"
AIPMS_AGENT_SIGNING_SECRET="$(openssl rand -base64 32)"
AIPMS_AGENT_ID="procurement-agent-prod-1"
```

Static bootstrap credentials are not accepted by production tRPC endpoints.

---

## Development Commands

```bash
# Lint & format (Biome)
pnpm check        # Check only
pnpm format       # Auto-fix

# Typecheck
pnpm typecheck

# Build
pnpm build

# Database-blocked API unit tests (no PostgreSQL required)
pnpm --filter api test:unit

# API integration tests (requires matching DATABASE_URL and
# AIPMS_TEST_DATABASE_URL pointing to a disposable *_test database)
pnpm --filter api test

# Browser E2E (same disposable-database URL contract as API integration)
pnpm --filter web e2e

# Database
pnpm db:generate   # Generate Prisma client
pnpm db:migrate    # Apply migrations
pnpm db:seed       # Seed demo data
pnpm db:studio     # Prisma Studio UI
```

The unit lane selects only `test/unit/**/*.spec.ts` and the pure intake projection
spec. Its database mock fails on any default-client access. The normal API suite
still runs the fail-closed disposable-database guard; the unit lane is not a way
to run integration tests against a development database. Browser E2E enforces
that same guard before starting either server. Migrate and seed the explicitly
selected disposable database before running E2E; the audit pagination spec
appends isolated legacy fixtures and never removes append-only audit history.

---

Outbound messaging now has a bounded dispatcher for safely unsent staged rows.
It never automatically retries ambiguous sending/failed outcomes; the operations
probe alerts on aged messages and abandoned QBO claims. See
[`docs/message-dispatch-recovery.md`](docs/message-dispatch-recovery.md) for
configuration, delivery-time checks, and the remaining stale-sending workflow.
Automatic templates now resolve canonical business records and retain versioned
provenance; legacy auto drafts require review. See
[`docs/automatic-messaging.md`](docs/automatic-messaging.md) for parameter shapes,
rollout requirements, and the receipt-based delivery acknowledgement change.

Policy selection now shares version/scope precedence across requisitions,
event wakes, sourcing, and tax configuration. Publication serializes revision
allocation and audits retired predecessors. See
[`docs/agent-quotas.md`](docs/agent-quotas.md) for shared admission accounting,
partial-batch responses, run attribution and process-local concurrency limits.
See [`docs/policy-resolution.md`](docs/policy-resolution.md) for configuration shapes,
legacy ambiguity, draft/supersession behavior, and rollout requirements.

## Roadmap

| Phase | Status | Focus |
|-------|--------|-------|
| 0 | ✓ | Foundation (db, auth, basic routers) |
| 1 | ✓ | Core domain (catalog, vendor, policy, audit) |
| 2 | ✓ | Requisition → PO workflow |
| 3 | ✓ | Agent skills (intake drain, sourcing, ops; scoped M2M) |
| 4 | ✓ | Invoicing & 3-way match (receipts, intake, matching) |
| 5 | ✓ | Payment runs, vendor messaging relay, and QBO ERP synchronization |
| 6 | ✓ | Hardening (hash-chained audit, event DLQ, quotas) |
| 7 | ◐ | Enterprise packaging (Docker Compose, offline LLM, SSO/SCIM, cryptographic PO signing; legal qualification is deployment-specific) |

---

## License

Internal use only. Enterprise procurement system.