import { AsyncLocalStorage } from "node:async_hooks"
import type { ToolContext } from "eve/tools"

/**
 * §7.1 — per-run attribution for agent tool calls.
 *
 * Every agent action must be attributable to the run that produced it. The
 * eve session id is that identity: the API wakes a session, records the
 * session id as the agent run, and the tool calls of that session carry it
 * on every API call (the scoped bearer minted for the session carries the
 * run id claim).
 *
 * `defineTool` returns the definition object itself, so wrapping it keeps the
 * authored schema, description, approval policy, and model output intact and
 * only wraps `execute`.
 */
const runContext = new AsyncLocalStorage<{ runId?: string }>()

/** The eve session id of the tool call in flight, if any. */
export function currentAgentRunId(): string | undefined {
  return runContext.getStore()?.runId
}

export function defineAipmsTool<TDefinition extends object>(
  definition: TDefinition
): TDefinition {
  const execute = (definition as { execute?: unknown }).execute
  if (typeof execute !== "function") return definition
  const wrapped = {
    ...definition,
    execute(input: never, ctx: ToolContext) {
      return runContext.run({ runId: ctx?.session?.id }, () =>
        (execute as (input: never, ctx: ToolContext) => unknown)(input, ctx)
      )
    },
  }
  return wrapped as unknown as TDefinition
}
