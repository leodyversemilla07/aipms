# syntax=docker/dockerfile:1

# ── base: workspace with frozen dependencies + generated Prisma client ──────
# Single-tenant packaging: one image with three run targets (api / web / agent),
# so `docker compose up -d --build` is the whole deployment story.
FROM node:24-alpine AS base
RUN corepack enable
# Shared, pre-provisioned corepack cache: the runtime entrypoints run pnpm under
# the unprivileged user and must not depend on a first-run download.
ENV COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# The Prisma client is generated (git-ignored), never committed. Prisma 7
# resolves DATABASE_URL even for `generate`; the compose services override
# this placeholder at runtime.
ENV DATABASE_URL=postgresql://user:password@localhost:5432/aipms
RUN pnpm --filter @workspace/db db:generate

# ── web build: full dev tree (Tailwind+, TypeScript, co) ──────────────────────
# Next.js production runtime is self-contained in the `.next` artifact plus
# production dependencies (production-only install happens in runtime-base).
FROM base AS web-build
RUN pnpm --filter web build

# ── runtime base: production-only dependencies, non-root user ───────────────
# Build-only tooling (tsc types, vitest, Playwright, NestJS CLI, coverage)
# never enters the shipped api/web images. The generated Prisma client is
# copied from the build stage; `@prisma/client` and `prisma` ship as
# production dependencies (migrate-on-deploy runs inside this image).
# `next start` loads next.config.ts through Node's native type-stripping
# resolver (Node 24), so the web runtime needs no TypeScript either.
FROM node:24-alpine AS runtime-base
RUN corepack enable
ENV COREPACK_HOME=/usr/local/share/corepack
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY --from=base /app/packages/db/src/generated /app/packages/db/src/generated
ENV DATABASE_URL=postgresql://user:password@localhost:5432/aipms
RUN pnpm install --frozen-lockfile --prod \
 && addgroup -S aipms \
 && adduser -S -G aipms -h /home/aipms aipms \
 && chown -R aipms:aipms /app /home/aipms /usr/local/share/corepack
ENV HOME=/home/aipms
ENV NODE_ENV=production
USER aipms

# ── api ──────────────────────────────────────────────────────────────────────
# Migrate-on-deploy: `prisma migrate deploy` runs on every start, so upgrading
# is `docker compose up -d --build` — pending migrations apply before the
# server accepts traffic.
FROM runtime-base AS api
WORKDIR /app/apps/api
EXPOSE 3001
ENTRYPOINT ["sh", "-c", "pnpm --filter @workspace/db db:deploy && node --import @swc-node/register/esm-register src/main.ts"]

# ── web ──────────────────────────────────────────────────────────────────────
# Next.js. NEXT_PUBLIC_API_URL is baked into the rewrite destination at build
# time; the compose default (http://api:3001) matches the compose network.
FROM runtime-base AS web
COPY --from=web-build --chown=aipms:aipms /app/apps/web/.next /app/apps/web/.next
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_URL=http://api:3001
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]

# ── agent ────────────────────────────────────────────────────────────────────
# eve runtime: build once, then serve (production schedules only run in a
# built app served with `eve start`).
# eve evaluates agent/agent.ts during build, so the provider gate must be
# satisfiable here. The baked artifact reads env at startup, so the real
# provider is decided by the compose runtime environment; the placeholder
# below is build-time validation only and is overridden by the compose
# `environment:` block (or a root .env).
# eve's build is evaluated inside the full workspace on purpose: its runtime
# contract is opaque to pnpm pruning, so this target stays privilege-reduced
# only (non-root) rather than pruned.
FROM base AS agent
RUN addgroup -S aipms && adduser -S -G aipms -h /home/aipms aipms \
 && chown -R aipms:aipms /app /home/aipms /usr/local/share/corepack
ENV HOME=/home/aipms
USER aipms
WORKDIR /app/apps/agent
ENV NODE_ENV=production \
    AIPMS_LLM_KIND=cloud \
    AIPMS_LLM_API_KEY=placeholder-build-only
RUN pnpm --filter agent build
CMD ["sh", "-c", "pnpm --filter agent start"]
