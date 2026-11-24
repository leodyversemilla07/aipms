# Staging release validation

Promote the exact release commit intended for production. Do not rebuild or
redeploy a different commit per environment. Configure staging with independent
secrets, test IdP and provider tenants, inert payment destinations, and
production-equivalent TLS, reverse proxy, database, and process limits.

## Verify and deploy the candidate

Run **Release verification** manually with the full commit SHA from `main`.
The workflow verifies that commit is an ancestor of `origin/main`, repeats the
release test suite, and uploads
`release-manifest-<sha>/release-manifest.json`. The manifest pins the API, web,
and agent components to that immutable source SHA.

Deploy that exact commit to staging with the process manager of the target
host, using the restricted staging environment file:

```bash
pnpm deployment:preflight -- /secure/path/staging.env
```

Confirm the running processes report the manifest's source SHA before testing.
The same commit—not a later build—is the production promotion unit.

## Configuration preflight

Create the deployment environment file with mode `0600`, then validate it
without starting any process:

```bash
pnpm deployment:preflight -- /secure/path/staging.env
```

The preflight rejects HTTP origins, shared or placeholder secrets, demo
identities, a missing or unsecured `DATABASE_URL`, incomplete integration
credential groups, invalid LLM residency configuration, insecure IMAP, and
unsafe file permissions. Disabled optional integrations are reported as
warnings without printing secret values.

## Automated boundary check

```bash
STAGING_WEB_URL=https://aipms.staging.example.com \
STAGING_API_URL=https://api.aipms.staging.example.com \
OPERATIONS_MONITORING_TOKEN="$STAGING_MONITORING_TOKEN" \
TLS_MIN_VALID_DAYS=21 \
pnpm staging:validate
```

The read-only validator checks:

- Trusted TLS chains and minimum certificate lifetime for web and API origins.
- HTTP-to-HTTPS redirect behavior.
- CSP, HSTS, clickjacking, MIME-sniffing, referrer, and server-disclosure
  headers on application documents.
- API liveness and PostgreSQL-aware readiness.
- Anonymous rejection and authenticated access for operational gauges.
- The web-to-Better-Auth proxy boundary.

Set `STAGING_SKIP_HTTP_REDIRECT=1` only when HTTP is intentionally unreachable
from the validation runner; verify the load-balancer redirect separately.
Neither URL may contain credentials, and the monitoring token is never printed.

## Identity and integration checks

After the automated boundary check:

1. Sign in through each configured OIDC/SAML provider using least-privilege,
   procurement, finance, and administrator staging identities.
2. Provision, update, suspend, reactivate, and deprovision a SCIM user. Confirm
   sessions are revoked and stale browser access is denied.
3. Poll the staging IMAP mailbox with a unique invoice marker and confirm one
   intake document and one audit trail are created.
4. Send a vendor message to a controlled mailbox. Reconcile a simulated timeout
   through provider logs before testing the explicit retry path.
5. Export a synthetic journal to the QBO sandbox. Simulate an ambiguous outcome
   and verify a different finance principal must resolve it.
6. Generate pain.001 only with staging debtor and beneficiary accounts. Confirm
   no production banking endpoint is reachable.
7. Verify the Operations desk, operational gauges, audit-chain integrity, and
   all maker/checker denial cases.
8. Run the capacity protocol and disaster-recovery drill documented in
   `capacity-testing.md` and `disaster-recovery.md`.

## Secret rotation check

Rotate staging credentials one class at a time: monitoring token, agent service
token, agent bearer-signing key, Better Auth secret according to its session
invalidation policy, ERP token-envelope key, PO signing keys, IdP client
secret/certificate, IMAP credential, QBO OAuth secret/tokens, and LLM key. For
every rotation:

- Record owner, old/new key identifiers, start/end time, and expected impact.
- Deploy the new secret without placing it in browser bundles, command
  arguments, process environment dumps, or logs.
- Verify old credentials fail and new credentials succeed.
- Confirm audit, readiness, automation leases, and recovery queues remain
  healthy.
- Revoke the old credential at the provider after all replicas use the new one.

For the ERP envelope key specifically, set the old value in
`AIPMS_TOKEN_ENCRYPTION_PREVIOUS_SECRET`, deploy the new
`AIPMS_TOKEN_ENCRYPTION_SECRET`, exercise the QBO connection so lazy
re-encryption completes, and only then remove the previous key. Rotating
`BETTER_AUTH_SECRET` no longer rotates or invalidates ERP token envelopes.

A release is not production-ready when any real provider check is skipped,
TLS/header validation fails, old credentials remain usable, recovery creates a
duplicate side effect, or the documented RPO/RTO and capacity budgets are not
met.

## Fail-closed release evidence

Copy `docs/release-evidence.example.json` to the restricted release evidence
store (do not commit completed evidence when it contains internal ticket or
provider identifiers). Record an owner, timestamp, and evidence/change-record
identifier for every gate. `llmOcr` may be `human-review-only` only when the
release explicitly accepts that product boundary; `signatureAndLegal` may be
`integrity-only` only when no legally-qualified signature claim is made.

Validate the completed record against the release manifest:

```bash
pnpm release:gate -- \
  /secure/evidence/release-evidence.json \
  /secure/evidence/release-manifest.json
```

The command fails on components that are not pinned to the release source SHA,
mismatched deployed components, missing SBOM/provenance/signature claims for
container deployments, stale or incomplete validation records, untested
credential retirement, missing operational drills, or absent tax/legal review
evidence. This validates the evidence record; it does not manufacture provider,
operational, legal, or tax approval.
