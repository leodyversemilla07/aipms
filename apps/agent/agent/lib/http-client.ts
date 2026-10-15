/**
 * Deadline-aware HTTP client with controlled retries for the Eve agent runtime.
 *
 * All outbound HTTP calls from the agent runtime must carry an explicit deadline
 * so a slow or unreachable API cannot block agent loops indefinitely.
 *
 * Idempotent GET queries may be retried with exponential backoff on transient
 * network failures, timeouts, and rate limits. Non-idempotent POST requests are
 * never automatically retried because the outcome on the API server is
 * ambiguous (ambiguous outcome rule — §8.5, §16).
 */

export const DEFAULT_DEADLINE_MS = 30_000
export const DEFAULT_MAX_RETRIES = 2
export const BACKOFF_BASE_MS = 300
export const BACKOFF_JITTER = 0.25

export class HttpDeadlineExceeded extends Error {
  override readonly name = "HttpDeadlineExceeded"
  constructor(
    public readonly url: string,
    public readonly deadlineMs: number
  ) {
    super(`HTTP request to ${url} exceeded ${deadlineMs}ms deadline`)
  }
}

export class AmbiguousPostOutcomeError extends Error {
  override readonly name = "AmbiguousPostOutcomeError"
  constructor(
    public readonly url: string,
    public readonly method: string,
    public readonly cause: unknown
  ) {
    super(
      `Request ${method} ${url} failed with an ambiguous outcome (${cause instanceof Error ? cause.message : String(cause)}); automatic replay is refused`,
      { cause }
    )
  }
}

export class HttpRetriesExhausted extends Error {
  override readonly name = "HttpRetriesExhausted"
  constructor(
    public readonly url: string,
    public readonly attempts: number,
    public readonly lastError: unknown
  ) {
    super(
      `HTTP request to ${url} failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
  }
}

export interface FetchDeadlineOptions {
  deadlineMs?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

function resolveDeadlineMs(opts?: FetchDeadlineOptions): number {
  if (opts?.deadlineMs !== undefined) return opts.deadlineMs
  const envVal = process.env.AIPMS_HTTP_TIMEOUT_MS
  if (envVal) {
    const parsed = Number(envVal)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_DEADLINE_MS
}

function resolveMaxRetries(opts?: FetchDeadlineOptions): number {
  if (opts?.maxRetries !== undefined) return opts.maxRetries
  const envVal = process.env.AIPMS_HTTP_MAX_RETRIES
  if (envVal) {
    const parsed = Number(envVal)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_MAX_RETRIES
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error && err.name === "TimeoutError") return true
  if (
    err instanceof TypeError &&
    /fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(err.message)
  ) {
    return true
  }
  return false
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

function computeBackoffMs(attempt: number): number {
  const base = BACKOFF_BASE_MS * 2 ** attempt
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER
  return Math.round(base * jitter)
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fetch wrapper with per-request deadlines and controlled retries.
 *
 * GET requests: retried up to `maxRetries` times on transient failure or 429/5xx.
 * Non-GET requests (POST, PUT, DELETE): never retried on timeout or network
 * failure; throws AmbiguousPostOutcomeError to prevent duplicate side effects.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit = {},
  opts: FetchDeadlineOptions = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const isIdempotent = method === "GET" || method === "HEAD"
  const deadlineMs = resolveDeadlineMs(opts)
  const maxRetries = isIdempotent ? resolveMaxRetries(opts) : 0
  const sleep = opts.sleep ?? defaultSleep
  const totalAttempts = 1 + maxRetries

  let lastError: unknown

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(computeBackoffMs(attempt - 1))
    }

    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(deadlineMs)])
        : AbortSignal.timeout(deadlineMs)

      const res = await fetch(url, {
        ...init,
        signal,
      })

      // If idempotent request received a transient server error or rate-limit,
      // and we have remaining attempts, retry.
      if (
        isIdempotent &&
        isRetryableStatus(res.status) &&
        attempt < maxRetries
      ) {
        lastError = new Error(`HTTP ${res.status}`)
        continue
      }

      return res
    } catch (err) {
      lastError = err

      // Non-idempotent calls (POST) must NEVER be automatically replayed on
      // network failure or deadline timeout (ambiguous outcome rule).
      if (!isIdempotent) {
        throw new AmbiguousPostOutcomeError(url, method, err)
      }

      if (!isRetryableError(err) || attempt >= maxRetries) {
        break
      }
    }
  }

  if (
    lastError instanceof DOMException ||
    (lastError instanceof Error && lastError.name === "TimeoutError")
  ) {
    throw new HttpDeadlineExceeded(url, deadlineMs)
  }

  if (maxRetries > 0) {
    throw new HttpRetriesExhausted(url, totalAttempts, lastError)
  }

  throw lastError
}
