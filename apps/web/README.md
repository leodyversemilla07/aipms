# web — aipms operator desks

Next.js 16 App Router client for the procurement API (`apps/api`, NestJS +
tRPC). tRPC calls are proxied by `next.config.ts` rewrites to the API on
`:3001`; Better Auth lives on `/api/auth/*` (mounted by the API).

## Routes

- `/` — **Supervisory desk**: session gate, live counts, §10.2 exception
  queue (approve / reject), and requisition intake against the policy engine.
- `/finance` — **Finance desk**: invoice registration (engine derives
  VAT/EWT §8.4 + §9 three-way match), invoice list, and the §8.6 payment-run
  lifecycle (create draft → approve → execute → reconcile per line).
  Maker/checker (§16.4) is enforced server-side: the desk surfaces the
  "Maker and checker must differ" error with a hint to switch accounts.
- `/procurement` — **Procurement desk**: issue a PO from an approved
  requisition (budget commit + vendor gate in one transaction), confirm it,
  or request §10.1 cancellation through the human gate.
- `/audit` — **Audit trail**: §16 append-only review — filter the
  content-addressed, SHA-256-chained events by entity / action / free text.

## Running

```bash
pnpm dev            # api :3001 + web :3000
pnpm --filter @workspace/db exec tsx prisma/seed.ts   # idempotent demo master data
```

Sign up with any email/password (Better Auth, email verification off in dev).
