# AIPMS — AI-Native Procurement Management System

[![CI](https://github.com/leodyversemilla07/aipms/actions/workflows/ci.yml/badge.svg)](https://github.com/leodyversemilla07/aipms/actions/workflows/ci.yml)

**Status:** Enterprise-ready (v0.5) | **Deployment:** Single-tenant, self-hostable | **Runtime:** NestJS + tRPC + Next.js + eve

---

## What is AIPMS?

AIPMS is a **procurement management system where AI agents are the primary users**. Unlike traditional PMS tools that put humans in charge of every step, AIPMS flips the model:

- **Agents handle routine procurement workflows** end-to-end (requisitions → POs → invoice matching → payment)
- **Humans supervise, approve, and resolve exceptions** through a web cockpit
- **Every action is attributable, auditable, and replayable**

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
              │  Bearer: agent │  ← Service tokens for agents
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

**Total:** 97 procedures across 21 routers

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

### Prerequisites
- Node.js 24.x
- pnpm 11.23.0+
- Docker (for PostgreSQL)

### Install Dependencies
```bash
pnpm install
```

### Setup Database
```bash
# First copy .env.example to .env and fill the required Compose values.
# Start PostgreSQL
docker compose up -d postgres

# Generate Prisma client
pnpm db:generate

# Run seed (demo data)
pnpm db:seed
```

### Development
```bash
# Start API (http://localhost:3001)
pnpm dev --filter api

# Start Web (http://localhost:3000)
pnpm dev --filter web

# Start Agent (eve runtime)
pnpm dev --filter agent
```

### Seed Data
The seed creates:
- Budget `IT-PROD` 2026-01: ₱5,000,000
- Vendor: "Acme Office Supplies, Inc." (verified BDO bank)
- 2 catalog items
- Threshold: auto-approve up to ₱50,000

### Demo Mode
Enable demo identities (maker/checker) for §16.4 testing:
```bash
# In .env
AUTH_SEED_DEMO=1
```

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

The script uses dedicated default host ports (`3100`, `3101`, and `55432`) and removes its containers and volume when it exits. See [`docs/capacity-testing.md`](docs/capacity-testing.md) for the production-safe probe and staging protocol.

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
- Service token auth for agent runtime
- Audit trail for all actions
- Maker/checker separation for approvals, PO signatures, beneficiary changes,
  payment-run overrides, and ambiguous ERP dispatch resolution
- Idempotency keys everywhere (agent retries safe)

### Configuration

Key environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Auth signing key |
| `AIPMS_SERVICE_TOKEN` | Bootstrap credential for the agent token exchange and service API |
| `AIPMS_AGENT_SIGNING_SECRET` | Independent key for five-minute scoped agent bearers |
| `OPERATIONS_MONITORING_TOKEN` | Dedicated read-only token for operational exception gauges |
| `AIPMS_SMTP_HOST` / `AIPMS_SMTP_FROM` | TLS SMTP relay used for real vendor-message delivery |
| `AUTH_SEED_DEMO` | Seed demo users (maker/checker) |
| `AGENT_AUTORUN` | Enable the unattended intake drain loop |
| `AIPMS_AGENT_WAKE` | Enable event-driven agent wakes |
| `AIPMS_AGENT_SCOPES` | Replace the default automation capability grants |
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

All mutations use idempotency keys. Agent actions are auditable with `actorKind: 'agent'`.

---

## Agent Development

The agent (`apps/agent`) runs on the eve framework. See `apps/agent/AGENTS.md` for details.

### Tool Surface

The eve agent calls tRPC procedures directly:
- `agent.process({ id, idempotencyKey })` — Classify & register an invoice
- `agent.batch({ limit })` — Drain pending intake documents

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

# Tests
pnpm --filter api test

# Database
pnpm db:generate   # Generate Prisma client
pnpm db:migrate    # Apply migrations
pnpm db:seed       # Seed demo data
pnpm db:studio     # Prisma Studio UI
```

---

## Roadmap

| Phase | Status | Focus |
|-------|--------|-------|
| 0 | ✓ | Foundation (db, auth, basic routers) |
| 1 | ✓ | Core domain (catalog, vendor, policy, audit) |
| 2 | ✓ | Requisition → PO workflow |
| 3 | ✓ | Agent skills (intake drain, sourcing, ops; scoped M2M) |
| 4 | ✓ | Invoicing & 3-way match (receipts, intake, matching) |
| 5 | ✓* | Payment runs & vendor messaging relay (*ERP sync pending) |
| 6 | ✓ | Hardening (hash-chained audit, event DLQ, quotas) |
| 7 | ◐ | Enterprise packaging (Docker Compose, offline LLM, SSO/SCIM, cryptographic PO signing; legal qualification is deployment-specific) |

---

## License

Internal use only. Enterprise procurement system.