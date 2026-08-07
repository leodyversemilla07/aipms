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

## Tests

```bash
pnpm --filter @workspace/env test
```