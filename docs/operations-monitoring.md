# Production monitoring and alert routing

The API exposes three intentionally separate health surfaces:

| Endpoint | Authentication | Meaning |
| --- | --- | --- |
| `GET /health/live` | None | The API process is alive. Do not use this for traffic routing. |
| `GET /health/ready` | None | PostgreSQL is reachable and the instance may receive traffic. |
| `GET /health/operations` | Dedicated bearer token | Recovery-queue gauges used by the monitoring platform. |

`/health/operations` accepts only `Authorization: Bearer
$OPERATIONS_MONITORING_TOKEN`. Generate this token independently from the agent
service token, store it in the monitoring secret store, and never place it in a
query string. An unset token fails closed with HTTP 503; an invalid token returns
HTTP 401.

Example:

```bash
curl --fail --silent \
  -H "Authorization: Bearer $OPERATIONS_MONITORING_TOKEN" \
  https://api.example.com/health/operations
```

The response contains no message bodies, event payloads, account data, or actor
identifiers:

```json
{
  "ok": true,
  "status": "observed",
  "exceptions": {
    "deadLetters": 0,
    "relayClaims": 0,
    "staleRelayClaims": 0,
    "staleAgentRuns": 0,
    "failedMessages": 0,
    "ambiguousErpDispatches": 0,
    "checkedAt": "2026-09-18T10:00:00.000Z"
  }
}
```

## Minimum alerts

| Signal | Suggested condition | Owner | First response |
| --- | --- | --- | --- |
| Readiness | Any 503 for 2 consecutive probes | Platform | Remove instance from rotation; check PostgreSQL before restarting writers. |
| Dead letters | `deadLetters > 0` for 5 minutes | Application operations | Repair the subscriber, then use audited requeue with evidence. |
| Stale relay claims | `staleRelayClaims > 0` for 5 minutes | Application operations | Verify relay replicas and claim age; do not mutate claims manually. |
| Stale agent runs | `staleAgentRuns > 0` for 5 minutes | Automation operations | Verify worker and lease ownership, then use audited cancellation. |
| Failed messages | `failedMessages > 0` | Procurement/finance operations | Reconcile with the provider; retry only after confirmed non-delivery. |
| Ambiguous ERP dispatches | `ambiguousErpDispatches > 0` | Finance, high priority | Independently verify QBO outcome before resolving. Never automatically repost. |
| Monitoring endpoint | 401, 503, timeout, or stale `checkedAt` | Platform | Verify credential injection and API/database availability. |

Page immediately when readiness is unavailable across all replicas or when an
ambiguous ERP outcome could block a payment close. Ticket single recovery-queue
exceptions during staffed hours unless their age or volume breaches local SLOs.

## Infrastructure-owned alerts

These cannot be derived safely from the application database and must be
configured in the deployment platform:

- TLS certificate expiry and external HTTPS reachability.
- PostgreSQL CPU, connections, storage, replication lag, and transaction age.
- Container restart loops, memory pressure, and disk exhaustion.
- Backup job failure, missing checksum sidecar, and age of the newest off-host
  backup. Alert when no validated backup is produced within the required RPO.
- Restore-drill failure and the age of the last successful staging restore.
- IMAP, QBO, SSO/SCIM, and LLM-provider latency/rate-limit/error budgets.

Monitoring detects exceptions; it must not invoke recovery mutations. All
requeue, cancellation, redispatch, and financial resolution actions remain
human-authenticated, evidence-bearing, idempotent commands in the application.
