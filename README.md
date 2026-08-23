# AIPMS — AI-Native Procurement Management System

**Status:** Enterprise-ready (v0.4) | **Deployment:** Single-tenant, self-hostable | **Runtime:** NestJS + tRPC + Next.js + eve

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
- Scoped capabilities: `catalog.read`, `po.issue`, `invoice.match`, etc.
- Graduated topology: Phase 1 ships one operator agent; Phase 3+ adds specialists

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

---

## API Surface (tRPC Routers)

| Router | Procedures | Purpose |
|--------|-----------|---------|
| `users` | me | Current user session |
| `catalog` | list, create | Catalog items for sourcing |
| `vendor` | list, create, verifyBankAccount | Vendor management |
| `requisition` | create, submit, list | Purchase requests |
| `approval` | request, decide, list | Approval gates |
| `purchase-order` | issue, confirm, cancel, list | PO lifecycle |
| `intake` | ingest, classify, list | Document queue |
| `invoice` | register, list | Invoice matching |
| `agent` | process, batch | Agent tools (eve → API) |
| `audit` | list, meta | Audit trail |
| `policy` | list, create, taxConfig | Policy engine |
| `budget` | read, list | Budget tracking |
| `payment-run` | list, create, approve, execute | Payment workflow |
| `messaging` | submit, approve, reject, list, detail | §8.3 vendor messaging relay (tiered sends) |
| `receipt` | record, cancel, list, detail | §8.1 goods receipts (3-way match leg) |

**Total:** 53 procedures across 13 routers

---

## Web Desks

| Desk | Route | Purpose |
|------|-------|---------|
| Supervisory | `/` | Overview dashboard |
| Finance | `/finance` | Invoice register, payment runs |
| Procurement | `/procurement` | Request POs from requisitions |
| Intake | `/intake` | Email/EDI invoice queue |
| Audit | `/audit` | Event trail viewer |
| Master-data | `/master-data` | Vendors, catalog, budgets, policies |

---

## Getting Started

### Prerequisites
- Node.js 24.x
- pnpm 10.33.4+
- Docker (for PostgreSQL)

### Install Dependencies
```bash
pnpm install
```

### Setup Database
```bash
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
- Idempotency keys everywhere (agent retries safe)

### Configuration

Key environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection |
| `BETTER_AUTH_SECRET` | Auth signing key |
| `AIPMS_SERVICE_TOKEN` | M2M token for agent API |
| `AUTH_SEED_DEMO` | Seed demo users (maker/checker) |
| `AGENT_AUTORUN` | Enable agent drain loop |

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

### Service Token Auth

The agent authenticates with a bearer token:
```bash
# Generate
openssl rand -base64 32

# Set in .env
AIPMS_SERVICE_TOKEN="your-token-here"
```

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
| 3 | ○ | Agent skills (sourcing, ops) |
| 4 | ○ | Invoicing & 3-way match |
| 5 | ○ | Payment execution & ERP sync |
| 6 | ○ | Hardening (replay, dead-letter) |
| 7 | ○ | Enterprise packaging (Docker, offline LLM) |

---

## License

Internal use only. Enterprise procurement system.