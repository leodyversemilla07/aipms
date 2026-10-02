# `@workspace/env`

Loads environment variables from the **repo-root `.env` / `.env.local`** into
`process.env`, so any package (DB client, API, agent, seed scripts) works
without a running app.

## Usage

Import once at the top of an entrypoint:

```ts
// Side-effecting import — loads env before any other code runs.
import "@workspace/env/load";

console.log(process.env.DATABASE_URL);
```

Or call it programmatically:

```ts
import { loadRootEnv, parseEnv } from "@workspace/env";

loadRootEnv();
const vars = parseEnv(source);
```

## Behaviour

- Looks for the workspace root by walking up from `cwd`, detecting a `pnpm
  workspace (``pnpm-workspace.yaml``) or `workspaces` in `package.json`
  (npm/yarn/bun).
- Reads `.env`, then `.env.local` (later overrides earlier).
- **Never overrides** variables already present in `process.env`.
- `parseEnv` is a dependency-free `.env` parser exported for tooling (e.g. the
  `require-local-db` guard in `@workspace/db`).

## Exclusive environment selection

Set `AIPMS_ENV_FILE` in the process environment to load exactly one file
(relative to the workspace root, or absolute), instead of root `.env` /
`.env.local`. A missing/unreadable selected file fails closed. Existing process
values retain precedence. The local demo launcher selects its own file and
sanitizes inherited database/provider settings before starting child processes.
This selector governs `@workspace/env`, not Next.js's independent app-local
dotenv loader; the demo also passes its required web values explicitly.

## Disposable database guard

API integration and browser E2E import `@workspace/env/test-database` and call
its default export before running. It requires explicit, identical
`DATABASE_URL` / `AIPMS_TEST_DATABASE_URL` PostgreSQL URLs with a database name
ending in `_test`. It does not connect to the database or bypass any production
permission checks. The guard lives in `src`, so build-time typechecking does not
depend on test directories excluded from production images.

## Tests

```bash
pnpm --filter @workspace/env test
```