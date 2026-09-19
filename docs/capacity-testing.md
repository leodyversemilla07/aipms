# Capacity validation

`scripts/capacity-smoke.mjs` is a dependency-free, read-only concurrency probe
for the API and PostgreSQL path. It mixes readiness, operational exception
gauges, and paginated requisition, vendor, and audit metadata queries. This
exercises HTTP handling, monitoring authentication, short-lived agent token
exchange, centralized authorization, the Prisma pool, and indexed business and
recovery reads without creating business data.
It is a regression gate, not a substitute for a workload model.

The production image smoke runs 100 requests at concurrency 10. For staging,
start with:

```bash
CAPACITY_BASE_URL=https://api.staging.example.com \
OPERATIONS_MONITORING_TOKEN="$STAGING_MONITORING_TOKEN" \
CAPACITY_AGENT_BOOTSTRAP_TOKEN="$STAGING_AGENT_BOOTSTRAP_TOKEN" \
CAPACITY_REQUESTS=5000 \
CAPACITY_CONCURRENCY=25 \
CAPACITY_MAX_P95_MS=750 \
CAPACITY_MAX_ERROR_RATE=0.001 \
pnpm capacity:smoke
```

Plain HTTP targets are refused. `CAPACITY_ALLOW_INSECURE=1` exists only for the
isolated local production-smoke stack. Credentials in the URL are also refused.

Run the separate read-only browser workload with a dedicated least-privilege
staging identity. The wrapper fails on browser errors, unauthorized redirects,
empty reports, or an exceeded journey-duration/error budget and can emit a
mode-`0600` JSON evidence file:

```bash
STAGING_WEB_URL=https://aipms.staging.example.com \
STAGING_WORKLOAD_EMAIL="$STAGING_READONLY_EMAIL" \
STAGING_WORKLOAD_PASSWORD="$STAGING_READONLY_PASSWORD" \
STAGING_WORKLOAD_JOURNEYS=100 \
STAGING_WORKLOAD_WORKERS=10 \
STAGING_WORKLOAD_MAX_P95_MS=5000 \
STAGING_WORKLOAD_MAX_ERROR_RATE=0.001 \
STAGING_WORKLOAD_EVIDENCE=/secure/evidence/browser-workload.json \
pnpm staging:browser-workload
```

The reported latency is the complete authenticated multi-page browser journey,
not a single API request. Run from the intended user region and monitor the API,
PostgreSQL, reverse proxy, and IdP concurrently.

## Staging protocol

1. Use production-equivalent container limits, PostgreSQL sizing, indexes, and
   connection-pool configuration.
2. Use synthetic data at expected 12-month volume. Never copy unredacted bank,
   identity, message-body, or invoice data into a lower environment.
3. Establish a quiet baseline, then run concurrency 10, 25, 50, and the expected
   peak plus headroom. Stop before saturation affects shared dependencies.
4. Record p50/p95/p99 latency, error rate, API CPU/memory/restarts, PostgreSQL
   CPU/IO/connections/lock waits, and external-provider throttling.
5. Run a separate browser journey mix for procurement, finance, and operations;
   do not turn mutation journeys into a production load generator.
6. Verify recovery counters return to baseline and no audit, outbox, message, or
   ERP rows were duplicated.
7. Store the report, image digest, schema migration, data volume, and resource
   limits with the release evidence.

A release fails capacity validation when it exceeds the documented latency or
error budget, exhausts the database pool, causes restart/lock storms, or loses
maker/checker, idempotency, or audit guarantees under concurrency.
