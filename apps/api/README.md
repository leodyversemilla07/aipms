# `api` — NestJS + tRPC

The API server. Exposes a tRPC endpoint at `POST /api/trpc` (and `/api/auth/*`
via Better Auth) on port **3001**.

## Runtime

The API consumes `@workspace/*` packages that ship **TypeScript sources**, so it
runs on [tsx](https://tsx.is) (the pnpm/bun equivalent) rather than the Nest CLI:

```bash
pnpm --filter api dev      # tsx watch + nestjs-trpc watch (generates server.ts)
pnpm --filter api start    # production-ish: tsx src/main.ts
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

## Environment

Loaded from the repo-root `.env` via `@workspace/env` (see `.env.example`).
Required at boot: `DATABASE_URL` (db package), `BETTER_AUTH_SECRET`
(`betterAuth()` throws without it).
