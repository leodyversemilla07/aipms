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
- **The audit guard is applied by hand.** `db push` carries no triggers, so the
  append-only guard on the audit trail
  (`packages/db/prisma/sqlite/audit-append-only.sql`) is applied to the file
  after the schema. PostgreSQL gets the same guard from its migration
  (`20260918040000_audit_append_only`).
- **One schema change was needed.** `AgentRun.skills` was a native `text[]`;
  SQLite has no scalar lists, so the canonical schema now stores that list as
  JSON (the values are unchanged). The API still presents it as a plain string
  array, so the contract is identical on both engines.

## What differs

| Area | PostgreSQL | SQLite (local) |
|---|---|---|
| Concurrency | Row locks (`FOR UPDATE`) and transaction-scoped advisory locks | SQLite serialises writers for the whole transaction, so the locks are no-ops there |
| One open transaction | Many transactions run at once | The driver adapter allows one open transaction per client, so any other statement waits for it |
| Case-insensitive search | `mode: 'insensitive'` on the filter | SQLite's `LIKE` is already case-insensitive for ASCII and has no such option |
| JSON path filters | `path: ['outcome']` on a JSON column | Not supported; the payload is matched after the read |
| Null ordering | `nulls: 'last'` in an order | Not supported; SQLite sorts nulls first |
| Approval latency percentiles | `percentile_cont` in the database | Computed from the rows (same linear interpolation) |
| Month buckets | `date_trunc` / `to_char` | `strftime` |
| Skill aggregation | `jsonb_array_elements_text` | `json_each` |
| Audit chain sequence | Column default (`autoincrement`) | Assigned by the writer (SQLite can only auto-increment a primary key) |
| Audit append-only guard | Trigger from the migration history | The same trigger, applied by the local setup (`db push` carries no triggers) |
| Journal mode | Server-side | WAL, so the relay and the app can work at the same time |

Everything else - the money arithmetic, the policy engine, the tax engine, the
audit hash chain, the API contracts - is the same code on both engines. The
code compiles against either client, so one codebase serves both.

**One connection, one transaction.** The SQLite driver adapter serialises
every statement on a connection behind the open transaction: while a
transaction is running, no other statement on that connection can run. Two
consequences follow, and the code branches on them:

- A service that reads through the shared connection while it holds a
  transaction would wait for its own transaction to finish. The agent
  pipeline reads the intake preview through the caller's transaction, and the
  automation lease runs its guarded work without a lease transaction there.
- Two requests cannot overlap. The local environment is a single-user
  workstation, so the requests are served one after another; the browser
  suite and the CI lanes still run against PostgreSQL.

**What this does not prove.** A local SQLite run cannot catch a bug that only
PostgreSQL has (locking behaviour, isolation, aggregate edge cases, the
`FOR UPDATE` paths, the PostgreSQL-only query features above). The integration
and browser suites still run against PostgreSQL in CI, and that remains the
gate.

## Running the suites locally on SQLite

```bash
pnpm test:sqlite
```

That is the whole loop. The script creates a disposable `aipms_test.db` file
in `.local/`, generates the SQLite client, applies the schema, the audit
append-only guard and the seed data, then runs the database-blocked unit lane
and the integration lane. The file is removed and recreated on every run, so a
failed run never leaks state into the next one.

The probes that only PostgreSQL can produce are **skipped** there rather than
reported as failures:

| Probe | Why it cannot run on SQLite |
|---|---|
| PO cancellation against a pending invoice lock | The barrier waits for a `FOR UPDATE` statement; SQLite has no row locks |
| A staged message that must stay invisible until its transaction commits | SQLite serialises writers, so a reader cannot see the other side of a write |
| Two overlapping HTTP mutations sharing one command slot | A second connection cannot read its quota while the first holds a transaction |

Every other case runs on both engines.

The browser suite takes the same file, with the Prisma client regenerated for
the engine:

```bash
DATABASE_URL=file:/abs/path/to/aipms_test.db \
AIPMS_TEST_DATABASE_URL=file:/abs/path/to/aipms_test.db \
  pnpm --filter web exec playwright test
```

`pnpm test:sqlite` prepares that file (schema, audit guard, seed data) in
`.local/aipms_test.db`, so the browser suite can point at the same one:

```bash
DATABASE_URL=file:C:/path/to/aipms/.local/aipms_test.db \
AIPMS_TEST_DATABASE_URL=file:C:/path/to/aipms/.local/aipms_test.db \
  pnpm --filter web exec playwright test
```

The file name has to end in `_test`: the isolated-test guard accepts a
disposable SQLite file the same way it accepts a disposable PostgreSQL
database. The suite regenerates the Prisma client for the configured engine
before it boots the API.

## Troubleshooting

- **`DATABASE_URL` must be absolute.** The API, the web app and the Prisma CLI
  each run from a different directory; a relative `file:` URL would resolve
  differently in each of them. `pnpm dev:sqlite` writes an absolute path.
- **`AIPMS_ENV_FILE` is what selects the environment.** Without it the app
  reads `.env` and talks to PostgreSQL.
- **Regenerate the client after switching engines.** The generated client is
  engine-specific; `pnpm dev:sqlite` does it for you.
