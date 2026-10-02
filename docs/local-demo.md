# Local demo: setup and guided workflow

This is a **non-production, supervised demo**, not a financial deployment.
It does not start the AI runtime, send supplier email, poll IMAP, connect
QuickBooks, or transfer money.

## Bootstrap (Windows, macOS, Linux)

Install Node.js **24.x**, pnpm **12.7.0**, and Docker with its Compose plugin.
On Windows, start Docker Desktop's Linux engine first. The active Docker context
must use a local Unix socket or Windows named pipe; remote daemons are refused.

From the repository root:

```sh
pnpm demo:setup
```

Setup checks Docker, creates an ignored `.env.demo` with independent random
secrets, installs frozen dependencies, starts dedicated PostgreSQL, generates
Prisma, applies migrations, **then** seeds demo master data.

It does not overwrite `.env` or `.env.local`, select an inherited database URL,
reset a database, or remove volumes. Existing named demo resources must carry
the ownership ID from `.env.demo`; foreign resources fail closed.

| Resource | Demo value |
| --- | --- |
| Database | `aipms_demo`, loopback port **55433** |
| Container | `aipms-demo-postgres` |
| Volume | `aipms-demo-postgres-data` |
| Compose | `docker-compose.demo.yml`, not the deployment Compose file |

Repeating setup reuses credentials/data and applies pending migrations. The
seed adds/backfills its known demo records; it does not undo workflows.

Credential files are created with POSIX mode 0600. On Windows, protect them with
local filesystem ACLs. Do not commit, upload, or share `.env.demo`.

Start the apps in **separate terminals**:

```sh
pnpm demo:api
pnpm demo:web
```

Both apps bind to loopback. API startup is watcher-free to avoid router codegen
restart loops; restart its terminal after backend source changes.

Check readiness:

```sh
pnpm demo:status
```

Open **http://localhost:3000**. Use localhost consistently for auth cookies.

| Identity | Password | Purpose |
| --- | --- | --- |
| `maker@demo.aipms` | `demo-maker-123` | Finance preparation |
| `checker@demo.aipms` | `demo-checker-123` | Independent approvals (demo admin) |

These known identities are seeded by non-production API startup. Public signup
remains disabled. Never enable demo identities in production.

## Guided procurement-to-payment exercise

Record each generated requisition, PO, invoice and payment-run number. Follow
your own records rather than selecting unrelated entries.

1. **Create a requisition as maker.** On the supervisory desk, choose
   **Compose**, select the seeded IT Production Ops budget, enter an A4 paper
   description, quantity **3**, and unit price **₱250**. Choose **Create &
   submit**. The seeded threshold allows this small requisition to auto-approve.
   Review any gate with checker rather than bypassing it.
2. **Issue the PO.** On Procurement, locate your requisition, select
   **Acme Office Supplies, Inc.**, and choose **Issue PO**. Expected total:
   **₱750**; budget commitment should increase by that amount.
3. **Confirm acceptance.** Expand your PO in Purchase orders and choose
   **Confirm** for this simulated acceptance. Invoice registration only offers
   confirmed POs.
4. **Record receipt.** Choose **Record a delivery…**, select the PO, and record
   all **3** units. A receipt exceeding remaining quantity must be refused.
5. **Register the invoice.** On Finance, select Acme and your confirmed PO,
   use a unique invoice number, and enter one goods line totaling **₱750**.
   For this **synthetic VAT-exempt fixture only**, check **VAT-free** so invoice
   gross equals PO/receipt value. Expected: **matched**, VAT ₱0, and withholding
   derived by the configured engine. Never declare a real invoice exempt merely
   to force matching.
6. **Create a draft run.** Select only your matched invoice and choose
   **Create draft run**. Record its number. Trying to approve the maker's own
   run must be refused.
7. **Approve independently.** Sign out and sign in as checker, or use a separate
   browser profile. Locate the draft on Finance and choose **Approve**.
8. **Inspect and execute the simulated hand-off.** Download and inspect the
   batch. The seeded bank account is fictional: **never upload this file to a
   real bank**. Choose **Execute** for the demo. This records hand-off state;
   it does not transfer money.
9. **Simulate reconciliation.** In the executed run's details, mark its planned
   line **Paid** only as an explicitly simulated result in this isolated demo.
   Real operations require actual bank/provider evidence. Inspect the updated
   invoice and run states.
10. **Export and inspect.** Choose **Export journal**, then inspect its frozen
    manifest in ERP sync. **Mark posted** may be used only as a simulated
    acknowledgement in this demo; the unclaimed export does not ask for a
    reference. Do not choose **Push to QBO** or claim a real external post.
11. **Audit.** Find your actions on Audit and choose **Verify full chain**.
    Verification should report an intact chain.

These suppliers, tax classifications and outcomes are fixtures, not tax advice
or a supported partial-payment/refund workflow. See
[financial corrections](financial-corrections.md) for current limitations.

## Stop and resume

Stop API/web with Ctrl+C, then:

```sh
pnpm demo:stop
```

Only demo PostgreSQL stops; its data volume is preserved. Resume with setup and
the two app commands. There is intentionally no reset/delete command. Do not
delete `.env.demo` while its resources exist: new credentials/ownership will
not match, and setup will refuse adoption.

## Troubleshooting and regression evidence

- **Docker unavailable:** start Docker Desktop/daemon. Setup stops before
  installing dependencies or creating credentials.
- **Port occupied:** free 3000, 3001, or 55433. Demo ports are fixed to keep
  auth and database targeting unambiguous.
- **Ownership mismatch:** investigate the resource and original env file; do
  not change ownership labels or reset it to bypass the guard.
- **Migration failure:** inspect the error. Setup stops before seeding and
  never attempts destructive cleanup.
- **Login fails:** check both terminals, use localhost, clear old browser
  cookies, and check API demo identity startup logs.
- **Invoice exceptions:** verify PO confirmation, vendor/currency, invoice
  gross versus PO value, and the full receipt.
- **Real integrations:** use a separately reviewed development environment;
  the bootstrap refuses settings enabling production, SMTP or automation.

`pnpm demo:test` runs database-free safety/orchestration regressions.
`pnpm demo:smoke` runs real setup, API/web readiness, and both authenticated
identities against the owned demo stack. It requires Docker and free ports,
stops the database afterwards, and never deletes its volume.
CI has a dedicated **Local demo bootstrap** job for that smoke. The manual
financial walkthrough is not claimed to be covered by this startup smoke.

API integration and browser E2E still require matching `DATABASE_URL` and
`AIPMS_TEST_DATABASE_URL` pointing to a disposable `*_test` database.
The demo database is **not** an integration-test target; no guard is bypassed.
