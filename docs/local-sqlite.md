# Local SQLite development environment

Every deployed environment runs PostgreSQL. A local development environment can
run the same application against a **SQLite file** instead: no database server
to install, no service to keep alive, and nothing to clean up beyond one file.

The schema is the canonical one - the same models, the same API contracts, the
same business rules. Only the engine differs, and the few engine-specific
statements branch on it (see "What differs" below).

## Use it

```bash
pnpm dev:sqlite          # create, migrate and seed the file database
AIPMS_ENV_FILE=.env.sqlite pnpm dev
```

`pnpm dev:sqlite` writes `.env.sqlite` (git-ignored) from your root `.env`,
swapping only the database:

```
DATABASE_URL=file:C:/path/to/repo/.local/aipms.db
```

Every other setting - the auth secret, the ports, the demo identities - is
inherited from `.env`, so the local environment stays the one you already
know. `AIPMS_ENV_FILE=.env.sqlite` tells the API, the web app and the agent
to read that file instead of `.env`.

The demo identities are seeded, so you can sign in immediately:

| Account | Password | Role |
|---|---|---|
| `maker@demo.aipms` | `demo-maker-123` | finance (maker) |
| `checker@demo.aipms` | `demo-checker-123` | admin (checker) |

To start over:

```bash
pnpm dev:sqlite --reset
```

## How it works

- **One schema, two providers.** `packages/db/prisma/schema.prisma` stays the
  canonical PostgreSQL schema. The local setup generates a variant from it
  (`packages/db/scripts/generate-sqlite-schema.mjs`) that only changes the
  datasource provider, so the two can never drift.
- **The client picks the adapter.** A `file:` URL selects the SQLite driver
  (`@prisma/adapter-libsql`); anything else selects PostgreSQL
  (`@prisma/adapter-pg`). The SQLite driver is a development-only
  dependency and is loaded on demand, so a production image never ships it.
- **Migrations vs. push.** The SQLite file is disposable, so it is created with
  `prisma db push` instead of the PostgreSQL migration history. PostgreSQL
  deployments keep `prisma migrate deploy` and the full migration chain.
- **One schema change was needed.** `AgentRun.skills` was a native `text[]`;
  SQLite has no scalar lists, so the canonical schema now stores that list as
  JSON (the values are unchanged). The API still presents it as a plain string
  array, so the contract is identical on both engines.

## What differs

| Area | PostgreSQL | SQLite (local) |
|---|---|---|
| Concurrency | Row locks (`FOR UPDATE`) and transaction-scoped advisory locks | SQLite serialises writers for the whole transaction, so the locks are no-ops there |
| Approval latency percentiles | `percentile_cont` in the database | Computed from the rows (same linear interpolation) |
| Month buckets | `date_trunc` / `to_char` | `strftime` |
| Skill aggregation | `jsonb_array_elements_text` | `json_each` |
| Audit chain sequence | Column default (`autoincrement`) | Assigned by the writer (SQLite can only auto-increment a primary key) |

Everything else - the money arithmetic, the policy engine, the tax engine, the
audit hash chain, the API contracts - is the same code on both engines.

**What this does not prove.** A local SQLite run cannot catch a bug that only
PostgreSQL has (locking behaviour, isolation, aggregate edge cases, the
`FOR UPDATE` paths). The integration and browser suites still run against
PostgreSQL in CI, and that remains the gate.

## Troubleshooting

- **`DATABASE_URL` must be absolute.** The API, the web app and the Prisma CLI
  each run from a different directory; a relative `file:` URL would resolve
  differently in each of them. `pnpm dev:sqlite` writes an absolute path.
- **`AIPMS_ENV_FILE` is what selects the environment.** Without it the app
  reads `.env` and talks to PostgreSQL.
- **Regenerate the client after switching engines.** The generated client is
  engine-specific; `pnpm dev:sqlite` does it for you.
