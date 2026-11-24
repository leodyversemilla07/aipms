import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * §7.1 — run attribution for agent actions.
 *
 * An agent's tools reach the API through many routers, and every one of them
 * writes audit entries. Threading the run id through each call site would put
 * the attribution rule in dozens of places; one request-scoped context keeps
 * it in one place instead.
 *
 * The run id is never taken from the caller: it comes from the five-minute
 * agent bearer the API minted for the eve session, so the agent cannot point
 * its actions at a run it does not own.
 */
const agentRunContext = new AsyncLocalStorage<{ runId?: string }>()

/** The run id of the agent call in flight, if any. */
export function currentAgentRunId(): string | undefined {
  return agentRunContext.getStore()?.runId
}

/**
 * Run `fn` with the given agent run id in scope. `runId` is left undefined
 * for human callers, and the audit trail then records no run id at all.
 */
export function withAgentRunContext<T>(
  runId: string | undefined,
  fn: () => T,
): T {
  return agentRunContext.run({ runId }, fn)
}
