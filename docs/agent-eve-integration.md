# Eve agent ↔ API ↔ web integration

How the `eve` agent runtime (`apps/agent`) and the NestJS API (`apps/api`)
work together, and what the web app (`apps/web`) shows of it.

This closes the edges of the architecture diagram in `docs/spec.md` §6:

```
WEB ──▶ API ──▶ EVE          (operator actions, run visibility)
EVE ──▶ API                   (agent tools, scoped bearers)
BUS ──.wake.─▶ EVE            (domain events become agent sessions)
```

## Roles

| Component | Process | Talks to | Credential |
| --- | --- | --- | --- |
| Eve runtime | `apps/agent` (`eve start`) | API | `AIPMS_SERVICE_TOKEN` (bootstrap) → `AIPMS_AGENT_SIGNING_SECRET` (scoped bearers) |
| API | `apps/api` | Eve runtime | `AIPMS_AGENT_ACCESS_TOKEN` (operator bearer) |
| Web | `apps/web` | API only | the human session cookie |

The web app never talks to the eve runtime directly. The operator bearer
(`AIPMS_AGENT_ACCESS_TOKEN`) is an inbound server-to-server credential; putting
it in browser code would turn the agent's whole capability set into a public
API. Everything the web needs is served by the API from the `AgentRun` rows.

## Wake edge: API → Eve

`AgentWakeService` (`apps/api/src/agent/agent-wake.service.ts`) subscribes to
domain events. With `AIPMS_AGENT_EVE_WAKE=1` **and** a configured runtime
address, it hands the event to eve instead of running the in-process
deterministic pipeline:

1. `AgentRuntimeService.wake()` posts to `POST <AIPMS_AGENT_EVE_URL>/eve/v1/session`
   with `{ message, operationId }` and the operator bearer.
2. `operationId` is `wake:<domainEventId>`. Eve creates the session once, so a
   redelivered event returns the same session instead of waking the agent
   twice; 429/5xx and transport failures are retried with the same id.
3. The eve session id becomes the `AgentRun.id`, and the run's `meta.delivery`
   records `{ channel: "eve", sessionId, deliveryId, operationId }`.
4. The wake message tells the agent what happened and to close the run with
   `complete_agent_run` when it is done.

Without `AIPMS_AGENT_EVE_WAKE=1` (the default) nothing changes: the API keeps
handling events itself, and the eve runtime stays available for interactive
use.

## Agent edge: Eve → API

Every agent tool reaches the API through the shared command boundary
(`AgentCommandService`), so capability checks, quotas, idempotency, and the
audit trail apply exactly as they do for the API's own handlers.

- The agent exchanges `AIPMS_SERVICE_TOKEN` for a five-minute scoped bearer at
  `POST /api/service/agent/token`.
- The exchange carries the eve session id as `runId`. The bearer is then
  bound to that run, and the API's audit rows carry it (`§7.1` — every action
  is attributable to the run that produced it).
- Tokens are cached per session, so one session never borrows another's
  identity, and concurrent sessions stay isolated.
- `complete_agent_run` calls `POST /api/service/agent/run/complete`, which
  closes the run (`succeeded`/`failed`), records a summary, and writes an
  `agent.run.complete` audit entry. The endpoint refuses to close a run owned
  by another principal and is idempotent.

### Run attribution

`apps/agent/agent/lib/agent-tool.ts` wraps every authored tool so the current
eve session id is available to the tool body (`currentAgentRunId()`), with
per-call isolation via `AsyncLocalStorage`. The session id is the run id, so
`AgentRun.id`, the audit rows, and the eve session are the same identity.

## Web edge: WEB → API

`apps/web/components/agent-runs.tsx` lists recent runs from the API's
`agent.runs` query and now shows, for each run that was handed to eve, the
session it ran in:

> handed to the eve runtime as session `wrun_…`

The run trace dialog still works unchanged: the trace is the API's audit
chain for that run id, which is the same id as the eve session.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `AIPMS_AGENT_EVE_URL` | API | Base URL of the eve runtime. A trailing `/eve/v1` is accepted and stripped. |
| `AIPMS_AGENT_EVE_WAKE` | API | `1` lets domain events wake the eve runtime. |
| `AIPMS_AGENT_EVE_TIMEOUT_MS` | API | Per-request deadline (default `10000`). |
| `AIPMS_AGENT_EVE_MAX_RETRIES` | API | Retry budget for 429/5xx and transport errors (default `2`). |
| `AIPMS_AGENT_ACCESS_TOKEN` | API | Operator bearer for the eve channel. Must match the agent's channel secret. |
| `AIPMS_SERVICE_TOKEN` | Agent | Bootstrap token for the API's token exchange. |
| `AIPMS_AGENT_SIGNING_SECRET` | API | HMAC key for the five-minute scoped bearers. |
| `AIPMS_AGENT_ID` | Both | Principal id of this agent runtime; the run's `agentId`. |
| `AIPMS_API_URL` | Agent | Base URL of the API. |

`AIPMS_AGENT_ACCESS_TOKEN` is shared between the two processes. Generate it
independently (`openssl rand -hex 32`), keep it out of browser bundles, and
use TLS for every hop.

## Deployment checklist

1. `AIPMS_AGENT_EVE_URL` must be reachable from the API process — over TLS in
   production, or through the internal network.
2. The agent's channel must authenticate the API as an operator. The shared
   `apps/agent/agent/channels/eve.ts` accepts `AIPMS_AGENT_ACCESS_TOKEN` as a
   `service` principal; without it the runtime denies every session route.
3. `GET <url>/eve/v1/health` is public and answers `{ ok, status, workflowId }`
   — use it as the readiness probe for the agent process.
4. The API's `AgentRuntimeService.health()` performs the same probe without
   the credential.
5. The agent still needs `AIPMS_LLM_API_KEY` (or `OPENAI_API_KEY`) and a
   reachable model endpoint; `eve info` must report `status: ready`.

## Failure behaviour

- The runtime refuses the wake (401/403/400): the event stays unpublished, so
  the relay retries or dead-letters it. No run row is created.
- The runtime is unreachable: the same, after the retry budget.
- The agent never closes its run: the run stays `running` and the agent-runs
  desk shows it as needing attention. There is no timeout that silently closes
  a run, because a run that is still working must not look finished.
