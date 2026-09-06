# `@workspace/auth`

Better Auth for the monorepo, shared by the `web` (Next.js) and `api`
(NestJS) apps. It persists to PostgreSQL through `@workspace/db` (Prisma 7 +
pg driver adapter).

## What's inside

- `src/auth.ts` — the server config: email/password (+ optional Google OAuth),
  Prisma adapter, session/cookie settings, DB-backed rate limiting.
- `src/client.ts` — `createAuthClient` from `better-auth/react` for the web app.
- `src/env.ts` — derives `BETTER_AUTH_URL`, `APP_URL`, trusted origins, cookie
  domain, and Google credentials from the repo-root `.env`.
- `src/cookies.ts` — the shared cookie prefix (`aipms`).

## Schema

The auth tables (`User`, `Session`, `Account`, `Verification`, `RateLimit`)
are **generated** into `@workspace/db/prisma/schema.prisma`. Regenerate after
changing the config or adding plugins:

```bash
pnpm run auth:generate   # writes into ../db/prisma/schema.prisma
pnpm run db:generate     # regenerate Prisma Client
pnpm run db:migrate      # create/apply the migration
```

> The generator is additive — it adds models and fields a plugin needs but
> never removes the ones a dropped plugin left behind, so removing a plugin
> means deleting its models from the schema by hand.

## Enrollment

Public email/password signup is disabled at the HTTP boundary, including
through the web proxy. The sign-in screen only accepts existing accounts.
Organization-managed SSO/SCIM can provision users; optional Google OAuth
can sign in existing users but cannot create new ones. Trusted server-side
provisioning can still call `auth.api.signUpEmail` directly. The local demo
seeder uses that path and remains disabled in production.

Vendor master-data writes require the procurement or admin role for humans.
Agents with `vendor.write` may create prospective vendors and update descriptive
fields, but cannot qualify vendors or change blacklist status/reasons.

## Environment

See the repo-root `.env.example`. Minimum:

```env
BETTER_AUTH_SECRET="<openssl rand -base64 32>"
BETTER_AUTH_URL="http://localhost:3000"
```

Optional: `APP_URL`, `AUTH_TRUSTED_ORIGINS`, `AUTH_COOKIE_DOMAIN`,
`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.

## Wiring into an app

- **Next.js:** add a route handler at `app/api/auth/[...all]/route.ts` using
  `toNextJsHandler(auth)`, and enable the `nextCookies()` plugin in the config.
- **Express/NestJS:** mount `toNodeHandler(auth)` on `/api/auth/*` and add
  `getSessionCookie` handling. The NestJS API should run on a TypeScript
  runtime (`tsx`/Bun) because this package ships TypeScript sources directly.
