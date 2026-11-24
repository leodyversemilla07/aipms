import { Inject, Injectable, Logger, Optional } from '@nestjs/common'

/**
 * §6 / §7.3 — client for the eve agent runtime (the `BUS -.wake.-> EVE`
 * edge of the architecture diagram).
 *
 * The API speaks the eve channel HTTP contract directly over two routes
 * (`GET /eve/v1/health`, `POST /eve/v1/session`) instead of importing the
 * `eve` package: that package ships the agent runtime's bundler and server
 * dependencies, which have no business inside the API process for two
 * endpoints. The eve HTTP contract is versioned and stable
 * (eve/docs/channels/eve.mdx), and the agent app already runs a separate
 * `eve start` process.
 *
 * Authentication uses the shared operator bearer (`AIPMS_AGENT_ACCESS_TOKEN`)
 * that `apps/agent` enforces in `agent/channels/eve.ts`. That credential is
 * inbound-only for the agent: it must never reach a browser, a log line, or
 * an error message.
 */

export const AGENT_RUNTIME_FETCH = 'AGENT_RUNTIME_FETCH'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RETRIES = 2
const RETRY_BASE_MS = 250
const MAX_ERROR_BODY_CHARS = 300

/** A wake that could not be delivered, or was refused by the runtime. */
export class AgentRuntimeError extends Error {
  override readonly name = 'AgentRuntimeError'

  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
  }
}

export interface AgentRuntimeHealth {
  ok: boolean
  status: string
  workflowId?: string
}

export interface AgentRuntimeDelivery {
  sessionId: string
  deliveryId?: string
}

interface RuntimeConfig {
  baseUrl: string
  token: string
  timeoutMs: number
  maxRetries: number
}

function positiveInteger(raw: string | undefined, fallback: number) {
  const parsed = Number(raw)
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  return fallback
}

/** Retry budget: 0 means "one attempt, never replay". */
function retryCount(raw: string | undefined, fallback: number) {
  const parsed = Number(raw)
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  return fallback
}

/**
 * Runtime base URL. A trailing `/eve/v1` (or `/eve/v1/`) is accepted and
 * stripped so an operator can paste either form. Credentials in the URL are
 * refused: they would land in request logs and process listings.
 */
export function resolveRuntimeBaseUrl(raw: string): string {
  let value = raw.trim()
  if (!value) throw new AgentRuntimeError('AIPMS_AGENT_EVE_URL is empty')
  value = value.replace(/\/+$/, '')
  value = value.replace(/\/eve\/v1$/, '')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgentRuntimeError('AIPMS_AGENT_EVE_URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentRuntimeError(
      'AIPMS_AGENT_EVE_URL must use http:// or https://',
    )
  }
  if (url.username || url.password) {
    throw new AgentRuntimeError(
      'AIPMS_AGENT_EVE_URL must not contain credentials',
    )
  }
  return value
}

@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name)

  constructor(
    @Optional()
    @Inject(AGENT_RUNTIME_FETCH)
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** True when both the runtime address and its operator credential exist. */
  isConfigured(env: NodeJS.ProcessEnv = process.env) {
    return Boolean(
      env.AIPMS_AGENT_EVE_URL?.trim() && env.AIPMS_AGENT_ACCESS_TOKEN?.trim(),
    )
  }

  /**
   * Public readiness probe (`GET /eve/v1/health`). Used by the deployment
   * checklist; it never carries the operator credential.
   */
  async health(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<AgentRuntimeHealth> {
    const config = this.config(env, { requireToken: false })
    const response = await this.request(config, 'GET', '/eve/v1/health')
    if (!response.ok) {
      throw new AgentRuntimeError(
        `Agent runtime health check failed (${response.status})`,
        response.status,
      )
    }
    const body = await this.readJson(response)
    if (!body || typeof body !== 'object') {
      throw new AgentRuntimeError(
        'Agent runtime health check returned a malformed body',
      )
    }
    const payload = body as {
      ok?: unknown
      status?: unknown
      workflowId?: unknown
    }
    if (payload.ok !== true || typeof payload.status !== 'string') {
      throw new AgentRuntimeError(
        'Agent runtime health check returned a malformed body',
      )
    }
    return {
      ok: true,
      status: payload.status,
      workflowId:
        typeof payload.workflowId === 'string' ? payload.workflowId : undefined,
    }
  }

  /**
   * Wake the agent: create a session and deliver the first message.
   *
   * The request carries an `operationId`, which eve uses for idempotent
   * session creation — a retry with the same id returns the original session
   * without sending the input twice. That is what makes retrying an
   * ambiguous POST safe here (the API never replays an unguarded POST).
   */
  async wake(
    input: { message: string; operationId: string },
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<AgentRuntimeDelivery> {
    const config = this.config(env)
    if (!input.message.trim()) {
      throw new AgentRuntimeError('Agent wake message is empty')
    }
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(input.operationId)) {
      throw new AgentRuntimeError(
        'Agent wake operationId contains invalid characters',
      )
    }

    const body = JSON.stringify({
      message: input.message,
      operationId: input.operationId,
    })
    let lastError: unknown
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
      try {
        const response = await this.request(
          config,
          'POST',
          '/eve/v1/session',
          {
            'content-type': 'application/json',
            authorization: `Bearer ${config.token}`,
          },
          body,
        )
        if (!response.ok) {
          const detail = this.redact(
            await this.safeText(response),
            config.token,
          ).slice(0, MAX_ERROR_BODY_CHARS)
          const retryable = response.status === 429 || response.status >= 500
          lastError = new AgentRuntimeError(
            `Agent runtime refused the wake (${response.status}): ${detail}`,
            response.status,
            retryable,
          )
          if (retryable && attempt < config.maxRetries) continue
          throw lastError
        }
        const payload = (await this.readJson(response)) as {
          ok?: unknown
          sessionId?: unknown
          deliveryId?: unknown
        } | null
        if (
          payload?.ok !== true ||
          typeof payload.sessionId !== 'string' ||
          !payload.sessionId.trim()
        ) {
          throw new AgentRuntimeError(
            'Agent runtime returned a malformed session response',
          )
        }
        return {
          sessionId: payload.sessionId,
          deliveryId:
            typeof payload.deliveryId === 'string'
              ? payload.deliveryId
              : undefined,
        }
      } catch (error) {
        if (error instanceof AgentRuntimeError && !error.retryable) throw error
        lastError = error
        if (attempt >= config.maxRetries) break
      }
    }
    this.logger.error(
      `Agent wake failed after ${config.maxRetries + 1} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
    throw lastError instanceof Error
      ? lastError
      : new AgentRuntimeError('Agent wake failed')
  }

  private config(
    env: NodeJS.ProcessEnv,
    options: { requireToken?: boolean } = {},
  ): RuntimeConfig {
    const rawUrl = env.AIPMS_AGENT_EVE_URL?.trim() ?? ''
    if (!rawUrl) {
      throw new AgentRuntimeError('AIPMS_AGENT_EVE_URL is not configured')
    }
    const token = env.AIPMS_AGENT_ACCESS_TOKEN?.trim() ?? ''
    if (options.requireToken !== false && !token) {
      throw new AgentRuntimeError('AIPMS_AGENT_ACCESS_TOKEN is not configured')
    }
    return {
      baseUrl: resolveRuntimeBaseUrl(rawUrl),
      token,
      timeoutMs: positiveInteger(
        env.AIPMS_AGENT_EVE_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      ),
      maxRetries: retryCount(
        env.AIPMS_AGENT_EVE_MAX_RETRIES,
        DEFAULT_MAX_RETRIES,
      ),
    }
  }

  private async request(
    config: RuntimeConfig,
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) {
    const fetchFn = this.fetchImpl ?? globalThis.fetch
    try {
      return await fetchFn(`${config.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      })
    } catch (error) {
      throw new AgentRuntimeError(
        `Agent runtime request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        true,
      )
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new AgentRuntimeError(
        'Agent runtime returned a malformed JSON body',
      )
    }
  }

  private async safeText(response: Response) {
    try {
      return await response.text()
    } catch {
      return ''
    }
  }

  /** Never let the operator credential reach an error message. */
  private redact(text: string, token: string) {
    if (!token) return text
    return text.split(token).join('[redacted]')
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }
}
