# Staging release validation

Promote the exact release image digests intended for production. Do not rebuild
images per environment. Configure staging with independent secrets, test IdP and
provider tenants, inert payment destinations, and production-equivalent TLS,
reverse proxy, database, and container limits.

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
token, Better Auth secret according to its session invalidation policy, signing
keys, IdP client secret/certificate, IMAP credential, QBO OAuth secret/tokens,
and LLM key. For every rotation:

- Record owner, old/new key identifiers, start/end time, and expected impact.
- Deploy the new secret without placing it in image layers, browser bundles,
  command arguments, or logs.
- Verify old credentials fail and new credentials succeed.
- Confirm audit, readiness, automation leases, and recovery queues remain
  healthy.
- Revoke the old credential at the provider after all replicas use the new one.

A release is not production-ready when any real provider check is skipped,
TLS/header validation fails, old credentials remain usable, recovery creates a
duplicate side effect, or the documented RPO/RTO and capacity budgets are not
met.
