import './no-database'
import { describe, expect, it, vi } from 'vitest'
import {
  AmbiguousPostOutcomeError,
  HttpDeadlineExceeded,
  HttpRetriesExhausted,
  withDeadline,
} from '../../src/erp/fetch-with-deadline'
import {
  createJournalEntry,
  exchangeCode,
  type FetchLike,
  listAccounts,
  type QboConfig,
} from '../../src/erp/qbo-client'

const config: QboConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  environment: 'sandbox',
}

describe('QBO HTTP transport deadlines & retries', () => {
  it('executes successful GET (listAccounts) without unnecessary retries', async () => {
    const rawFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        QueryResponse: {
          Account: [
            {
              Id: 'acc-1',
              Name: 'Operating Expense',
              AccountType: 'Expense',
              Active: true,
            },
          ],
        },
      }),
    })

    const accounts = await listAccounts(
      config,
      'realm-1',
      'token-1',
      rawFetch as FetchLike,
    )
    expect(accounts).toEqual([
      { id: 'acc-1', name: 'Operating Expense', type: 'Expense' },
    ])
    expect(rawFetch).toHaveBeenCalledTimes(1)
  })

  it('retries idempotent GET (listAccounts) on transient network failure', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const rawFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed (ECONNRESET)'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          QueryResponse: {
            Account: [
              { Id: 'acc-2', Name: 'Cash', AccountType: 'Bank', Active: true },
            ],
          },
        }),
      })

    const fetcher = withDeadline(rawFetch as FetchLike, {
      maxRetries: 2,
      sleep,
    })

    const accounts = await listAccounts(config, 'realm-1', 'token-1', fetcher)
    expect(accounts).toHaveLength(1)
    expect(rawFetch).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('retries idempotent GET on HTTP 503 or 429 gateway/rate errors', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const rawFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          QueryResponse: {
            Account: [
              {
                Id: 'acc-3',
                Name: 'AP',
                AccountType: 'Accounts Payable',
                Active: true,
              },
            ],
          },
        }),
      })

    const fetcher = withDeadline(rawFetch as FetchLike, {
      maxRetries: 2,
      sleep,
    })

    const accounts = await listAccounts(config, 'realm-1', 'token-1', fetcher)
    expect(accounts[0]?.id).toBe('acc-3')
    expect(rawFetch).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('throws HttpRetriesExhausted when all GET attempts fail', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const rawFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const fetcher = withDeadline(rawFetch as FetchLike, {
      maxRetries: 2,
      sleep,
    })

    await expect(
      listAccounts(config, 'realm-1', 'token-1', fetcher),
    ).rejects.toThrow(HttpRetriesExhausted)
    expect(rawFetch).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('throws HttpDeadlineExceeded when GET times out on single-shot call', async () => {
    const abortErr = new DOMException('Operation timed out', 'TimeoutError')
    const rawFetch = vi.fn().mockRejectedValue(abortErr)

    const fetcher = withDeadline(rawFetch as FetchLike, {
      deadlineMs: 50,
      maxRetries: 0,
    })

    await expect(
      listAccounts(config, 'realm-1', 'token-1', fetcher),
    ).rejects.toThrow(HttpDeadlineExceeded)
    expect(rawFetch).toHaveBeenCalledTimes(1)
  })

  it('refuses to retry POST createJournalEntry on network failure (ambiguous outcome rule)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const rawFetch = vi
      .fn()
      .mockRejectedValue(new TypeError('network socket disconnected'))

    const fetcher = withDeadline(rawFetch as FetchLike, {
      maxRetries: 3,
      sleep,
    })

    await expect(
      createJournalEntry(
        config,
        'realm-1',
        'token-1',
        { DocNumber: 'DOC-1', TxnDate: '2026-10-15', Line: [] },
        fetcher,
      ),
    ).rejects.toThrow(AmbiguousPostOutcomeError)

    // MUST NOT replay mutating POST: exactly 1 attempt
    expect(rawFetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('refuses to retry POST createJournalEntry on timeout (ambiguous outcome rule)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const abortErr = new DOMException('Operation aborted', 'AbortError')
    const rawFetch = vi.fn().mockRejectedValue(abortErr)

    const fetcher = withDeadline(rawFetch as FetchLike, {
      deadlineMs: 100,
      maxRetries: 3,
      sleep,
    })

    await expect(
      createJournalEntry(
        config,
        'realm-1',
        'token-1',
        { DocNumber: 'DOC-2', TxnDate: '2026-10-15', Line: [] },
        fetcher,
      ),
    ).rejects.toThrow(AmbiguousPostOutcomeError)

    expect(rawFetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('refuses to retry POST exchangeCode on network failure', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const rawFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'))

    const fetcher = withDeadline(rawFetch as FetchLike, {
      maxRetries: 3,
      sleep,
    })

    await expect(
      exchangeCode(config, 'code-xyz', 'https://example.com/callback', fetcher),
    ).rejects.toThrow(AmbiguousPostOutcomeError)

    expect(rawFetch).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('does not re-wrap an already wrapped fetchImpl (idempotent withDeadline)', () => {
    const rawFetch = vi.fn() as unknown as FetchLike
    const wrapped1 = withDeadline(rawFetch)
    const wrapped2 = withDeadline(wrapped1)
    expect(wrapped2).toBe(wrapped1)
  })
})
