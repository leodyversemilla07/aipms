/**
 * Deadline-aware fetch wrapper for external HTTP integrations.
 *
 * Every outbound HTTP call must carry an explicit timeout so a slow or
 * unreachable provider cannot stall the process indefinitely. Idempotent
 * GETs may be retried with exponential backoff; non-idempotent POSTs are
 * never automatically retried because the remote side may have already
 * committed the operation (ambiguous outcome rule — §8.5).
 */

import type { FetchLike } from './qbo-client'

/** Default deadline for a single HTTP attempt (milliseconds). */
export const DEFAULT_DEADLINE_MS = 30_000

/** Default backoff schedule for retryable (GET-only) calls. */
export const DEFAULT_MAX_RETRIES = 2

/** Base delay for the first retry attempt (milliseconds). */
export const BACKOFF_BASE_MS = 300

/** Jitter factor — actual delay is base * 2^attempt * (1 ± jitter). */
export const BACKOFF_JITTER = 0.25

export const IS_DEADLINE_WRAPPED = Symbol('isDeadlineWrapped')

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when a single HTTP call exceeds its deadline. */
export class HttpDeadlineExceeded extends Error {
  override readonly name = 'HttpDeadlineExceeded'
  constructor(
    public readonly url: string,
    public readonly deadlineMs: number,
  ) {
    super(`HTTP request to ${url} exceeded ${deadlineMs}ms deadline`)
  }
}

/**
 * Thrown when a non-idempotent HTTP request (e.g. POST) fails due to a network
 * failure or timeout. The outcome on the remote server is ambiguous, so automatic
 * replay is refused to prevent duplicate external mutations (§8.5).
 */
export class AmbiguousPostOutcomeError extends Error {
  override readonly name = 'AmbiguousPostOutcomeError'
  constructor(
    public readonly url: string,
    public readonly method: string,
    public readonly cause: unknown,
  ) {
    super(
      `Request ${method} ${url} failed with an ambiguous outcome (${cause instanceof Error ? cause.message : String(cause)}); automatic replay is refused`,
      { cause },
    )
  }
}

/** Thrown after all retry attempts for an idempotent call are exhausted. */
export class HttpRetriesExhausted extends Error {
  override readonly name = 'HttpRetriesExhausted'
  constructor(
    public readonly url: string,
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(
      `HTTP request to ${url} failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DeadlineFetchOptions {
  /** Per-attempt timeout in milliseconds. Defaults to DEFAULT_DEADLINE_MS. */
  deadlineMs?: number
  /**
   * Maximum retry count for **idempotent** requests (GET only).
   * Set to 0 for non-idempotent methods. Defaults to DEFAULT_MAX_RETRIES for GET.
   */
  maxRetries?: number
  /**
   * Override the sleep function (for unit testing).
   */
  sleep?: (ms: number) => Promise<void>
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'TimeoutError') return true
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Wrap a `FetchLike` with per-call deadlines and controlled retries.
 *
 * **POST / PUT / DELETE** calls are **never** retried — an in-flight network
 * disruption or timeout yields an ambiguous remote state. Only **GET** calls
 * are retried up to `maxRetries` times with exponential back-off and jitter.
 */
export function withDeadline(
  fetchImpl: FetchLike,
  opts: DeadlineFetchOptions = {},
): FetchLike {
  // Prevent redundant double-wrapping
  if (
    typeof fetchImpl === 'function' &&
    (fetchImpl as unknown as Record<symbol, boolean>)[IS_DEADLINE_WRAPPED]
  ) {
    return fetchImpl
  }

  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const defaultRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const sleep = opts.sleep ?? defaultSleep

  const wrapped: FetchLike = async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const isIdempotent = method === 'GET' || method === 'HEAD'
    const retries = isIdempotent ? defaultRetries : 0
    const totalAttempts = 1 + retries
    let lastError: unknown

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(computeBackoffMs(attempt - 1))
      }

      try {
        const signal = init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(deadlineMs)])
          : AbortSignal.timeout(deadlineMs)

        const res = await fetchImpl(url, {
          ...init,
          signal,
        })

        // Retry idempotent GET if server returned rate-limit or transient gateway/server failure
        if (
          isIdempotent &&
          isRetryableStatus(res.status) &&
          attempt < retries
        ) {
          lastError = new Error(`HTTP ${res.status}`)
          continue
        }

        return res
      } catch (err) {
        lastError = err

        // Non-idempotent operations must never replay on ambiguous failure
        if (!isIdempotent) {
          throw new AmbiguousPostOutcomeError(url, method, err)
        }

        if (!isRetryableError(err) || attempt >= retries) {
          break
        }
      }
    }

    if (
      lastError instanceof DOMException ||
      (lastError instanceof Error && lastError.name === 'TimeoutError')
    ) {
      throw new HttpDeadlineExceeded(url, deadlineMs)
    }

    if (retries > 0) {
      throw new HttpRetriesExhausted(url, totalAttempts, lastError)
    }

    throw lastError
  }

  ;(wrapped as unknown as Record<symbol, boolean>)[IS_DEADLINE_WRAPPED] = true
  return wrapped
}
