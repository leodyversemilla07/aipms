# `@workspace/db`

PostgreSQL access for the monorepo: the Prisma schema, migrations, and a shared
`PrismaClient` instance.

## Usage

```ts
import { db } from "@workspace/db";

const users = await db.user.findMany({ take: 10 });
```

Types and query helpers come from the same entrypoint:

```ts
import { Prisma, type User } from "@workspace/db";
```

## Setup

```bash
docker compose up -d     # or point DATABASE_URL at any Postgres
cp .env.example .env     # at the repo root
pnpm db:generate         # generate Prisma Client
pnpm db:deploy           # apply the migrations
```

`DATABASE_URL` comes from the **repo-root `.env`**, loaded by `@workspace/env`.
`src/client.ts` imports `@workspace/env/load` before reading it, and
`prisma.config.ts` does the same so the CLI works without any app running.

## Scripts

Each is also exposed at the repo root (`pnpm run db:migrate`) and routed through
`turbo run`.

| Script          | Purpose                                                  |
| --------------- | -------------------------------------------------------- |
| `build`         | `prisma generate` — cached by Turborepo, runs via `^build` |
| `db:generate`   | Regenerate Prisma Client                                 |
| `db:migrate`    | Create and apply a migration (development)               |
| `db:deploy`     | Apply pending migrations (CI / production)               |
| `db:push`       | Push the schema without a migration (prototyping only)   |
| `db:reset`      | Drop and recreate the database                           |
| `db:seed`       | Run `prisma/seed.ts`                                     |
| `db:studio`     | Open Prisma Studio                                       |

## Notes

- **Prisma 7 + driver adapter.** There is no query-engine binary; the client
  talks to PostgreSQL through `@prisma/adapter-pg`. See `src/client.ts`.
- **Generated code is not committed.** `prisma generate` writes to
  `src/generated/`, which is gitignored and declared as the `build` task's
  output so Turborepo caches it.
- **JIT package.** The `exports` point at TypeScript sources; the consumer
  compiles them. Turbopack transpiles workspace packages automatically, so a
  Next.js app needs no `transpilePackages` entry for this package. Non-bundler
  consumers need a TypeScript runtime (e.g. `tsx`).
- **The schema is a starting point.** Add models to `prisma/schema.prisma` and
  run `pnpm run db:migrate` to create and apply a migration.