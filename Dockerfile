# syntax=docker/dockerfile:1

# ── base: workspace with frozen dependencies + generated Prisma client ──────
# Single-tenant packaging: one image with three run targets (api / web / agent),
# so `docker compose up -d --build` is the whole deployment story.
FROM node:24-alpine AS base
RUN corepack enable
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

# ── api ──────────────────────────────────────────────────────────────────────
# Migrate-on-deploy: `prisma migrate deploy` runs on every start, so upgrading
# is `docker compose up -d --build` — pending migrations apply before the
# server accepts traffic.
FROM base AS api
WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 3001
ENTRYPOINT ["sh", "-c", "pnpm --filter @workspace/db db:deploy && node --import @swc-node/register/esm-register src/main.ts"]

# ── web ──────────────────────────────────────────────────────────────────────
# Next.js. NEXT_PUBLIC_API_URL is baked into the rewrite destination at build
# time; the compose default (http://api:3001) matches the compose network.
FROM base AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_URL=http://api:3001
RUN pnpm --filter web build
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]

# ── agent ────────────────────────────────────────────────────────────────────
# eve runtime: build once, then serve (production schedules only run in a
# built app served with `eve start`).
FROM base AS agent
WORKDIR /app/apps/agent
ENV NODE_ENV=production
RUN pnpm --filter agent build
CMD ["sh", "-c", "pnpm --filter agent start"]