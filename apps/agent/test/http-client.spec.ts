import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AmbiguousPostOutcomeError,
  fetchWithDeadline,
  HttpDeadlineExceeded,
  HttpRetriesExhausted,
} from "../agent/lib/http-client"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("Eve agent HTTP client (deadlines & retries)", () => {
  it("executes successful GET without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const res = await fetchWithDeadline("https://api.example.com/test")
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries idempotent GET on transient network failures up to maxRetries", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      )
    vi.stubGlobal("fetch", fetchMock)

    const res = await fetchWithDeadline(
      "https://api.example.com/test",
      { method: "GET" },
      { maxRetries: 2, sleep: sleepMock }
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledTimes(1)
  })

  it("retries idempotent GET on 503 Service Unavailable", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("Service Unavailable", { status: 503 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ recovered: true }), { status: 200 })
      )
    vi.stubGlobal("fetch", fetchMock)

    const res = await fetchWithDeadline(
      "https://api.example.com/status",
      { method: "GET" },
      { maxRetries: 1, sleep: sleepMock }
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledTimes(1)
  })

  it("throws HttpRetriesExhausted when all GET retries fail", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("ECONNRESET"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      fetchWithDeadline(
        "https://api.example.com/flaky",
        { method: "GET" },
        { maxRetries: 2, sleep: sleepMock }
      )
    ).rejects.toThrow(HttpRetriesExhausted)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleepMock).toHaveBeenCalledTimes(2)
  })

  it("throws HttpDeadlineExceeded when single-attempt GET times out", async () => {
    const timeoutErr = new DOMException(
      "The operation was aborted.",
      "TimeoutError"
    )
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(timeoutErr)
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      fetchWithDeadline(
        "https://api.example.com/slow",
        { method: "GET" },
        { deadlineMs: 50, maxRetries: 0 }
      )
    ).rejects.toThrow(HttpDeadlineExceeded)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("refuses to auto-retry POST requests on network failure (ambiguous outcome rule)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network error"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      fetchWithDeadline(
        "https://api.example.com/mutate",
        { method: "POST", body: JSON.stringify({ amount: 100 }) },
        { maxRetries: 3, sleep: sleepMock }
      )
    ).rejects.toThrow(AmbiguousPostOutcomeError)

    // MUST be called exactly once — no replay of mutating POST!
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it("refuses to auto-retry POST requests on timeout (ambiguous outcome rule)", async () => {
    const sleepMock = vi.fn().mockResolvedValue(undefined)
    const timeoutErr = new DOMException(
      "The operation was aborted.",
      "AbortError"
    )
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(timeoutErr)
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      fetchWithDeadline(
        "https://api.example.com/mutate",
        { method: "POST", body: JSON.stringify({ action: "issue-po" }) },
        { deadlineMs: 50, maxRetries: 3, sleep: sleepMock }
      )
    ).rejects.toThrow(AmbiguousPostOutcomeError)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it("returns completed error responses (e.g. 400) directly for POST without retrying", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Bad Request", { status: 400 }))
    vi.stubGlobal("fetch", fetchMock)

    const res = await fetchWithDeadline("https://api.example.com/mutate", {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
