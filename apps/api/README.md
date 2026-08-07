# `api` — NestJS + tRPC

The API server. Exposes a tRPC endpoint at `POST /api/trpc` (and `/api/auth/*`
via Better Auth) on port **3001**.

## Runtime

The API consumes `@workspace/*` packages that ship **TypeScript sources**, so
it runs on `node` with the **SWC loader** (`@swc-node/register`) rather than
`tsx`/the Nest CLI — SWC emits Nest's decorator metadata (Nest DI breaks under
esbuild), and the loader resolves the workspace `.ts` packages:

```bash
pnpm --filter api dev      # node --watch (SWC loader) + nestjs-trpc watch
pnpm --filter api start    # production-ish: node (SWC loader) src/main.ts
```

> A real `dist` bundle (for serverless/containers) is a follow-up: it needs to
> bundle the workspace `.ts` packages (e.g. `tsup`), like crm's `bun build`.

## How tRPC is wired

Mirrors the crm reference:

- `src/trpc/trpc.module.ts` — `TRPCModule.forRoot({ basePath: "/api/trpc", ... })`
  with the context, error formatter, error handler and global middlewares.
- `src/trpc/trpc.context.ts` — resolves the Better Auth session from request
  headers (`auth.api.getSession`) into the tRPC context.
- `src/trpc/middlewares/auth.middleware.ts` — requires `ctx.user`, else
  `UNAUTHORIZED`. Apply per-router with `@UseMiddlewares(AuthMiddleware)`.
- `src/generated/server.ts` — **auto-generated** router + `AppRouter` type,
  regenerated with:

  ```bash
  pnpm --filter api trpc:generate    # or the dev watcher above
  ```

  It is exported to consumers as `api/app-router` (see `package.json` exports)
  and is used **type-only** by the web app.

## Adding a router

1. Create `src/<feature>/<feature>.router.ts` — a class decorated with
   `@Router({ alias })`, `@Query()` / `@Mutation()` methods, and
   `@Input()` for zod contracts.
2. Register it in a feature `@Module({ providers: [Router, Service] })` and add
   the module to `AppModule`.
3. Re-run `trpc:generate` so the client types update.
4. On the client, invalidate caches via `useTRPC().<alias>.<proc>.queryKey()`.

## Domain core (Phase 1)

Feature modules under `src/<feature>/`, all behind `AuthMiddleware`:

- `catalog` — `list`, `detail`, `create`, `update`, `deactivate` (SKU master)
- `vendor` — `list`, `detail`, `create`, `update` (qualification/blacklist)
- `budget` — `list`, `detail` (`includeRemaining`), `create` (minor-units money)
- `policy` — `list`, `detail`, `activeByKind`, `create` (versioned; `supersedesId`
  bumps `version`; `evaluationCriterion` carries the §9 award seam)

## Requisition → PO (Phase 2)

- `requisition` — `create` (draft), `submit`, `list`, `detail`, `exceptionQueue`
  (§10.2). `submit` evaluates the §11 gate **inside the same transaction**:
  PASS auto-approves, NEED_APPROVAL creates a pending `approval`, BLOCK moves
  the requisition to `exception`.
- `approval` — `pendingList` (the exception queue surface), `detail`, `decide`
  (approve / reject / override with reason). Approving a vendor gate qualifies
  the vendor; approving a PO cancellation releases the committed budget.
- `purchaseOrder` — `issue` (transactional budget commit, §9: never
  read-then-write; hard-blocks blacklisted vendors, gates unqualified ones),
  `confirm`, `requestCancellation` (human gate), `list`, `detail`.
- `src/policy/policy-engine.ts` — pure `(policy, context) → decision`
  (`PASS | NEED_APPROVAL | BLOCK` + citations); threshold, budget-override
  and vendor gates per §10.1/§11.
- Document numbers (`REQ-…`, `PO-…`) via `shared/document-number`.

## Tax + invoice intake (Phase 4)

- `packages/tax` — the deterministic §8.4 PH engine (`computeTax`): input VAT
  12% (RA 9337) + creditable withholding (EWT) by goods/service class, rounded
  to centavos, net = gross + VAT − EWT. Pure, no I/O, no LLM; unit-tested.
- `taxRule` joins `PolicyKind` — rates are **policy data** (config-over-fork);
  `PolicyService.taxConfig()` resolves it and falls back to the PH default so
  the engine never silently fails.
- `intake` — the §8.2 normalized queue (`ingest` dedupe by `[channel,
  contentHash]`, `classify` → `extracted`, `drop`, `requeue`); every supplier
  e-invoice (EIS XML/JSON, Peppol, EDI, email) enters here.
- `invoice` — `register` computes VAT/EWT deterministically then runs the §9
  three-way match (PO total ± 5% tolerance): `matched` | `exception`
  (amount/vendor mismatch); dedupes re-ingested `[vendor, number]`. `compute`
  is the foot the agent calls to *explain* a net, never to derive it.

Cross-cutting invariants (§9):

- **Idempotency** (`src/shared/idempotency`) — every mutation takes an
  `idempotencyKey`; a replay returns the stored outcome (claim protocol, so
  concurrent retries are safe and agent retries are idempotent).
- **Audit** (`src/shared/audit`) — every mutation records an append-only
  `AuditEntry` (actor, action, entity, content-hashed input, before/after).
  No update/delete path is exposed for `AuditEntry`.
- **Money** — stored as `*Minor` integers + `*CurrencyCode` (PHP default),
  per §8.4; no floats in the domain.

## Environment

Loaded from the repo-root `.env` via `@workspace/env` (see `.env.example`).
Required at boot: `DATABASE_URL` (db package), `BETTER_AUTH_SECRET`
(`betterAuth()` throws without it).
