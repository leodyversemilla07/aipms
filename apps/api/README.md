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
