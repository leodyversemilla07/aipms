import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntimeError,
  AgentRuntimeService,
  resolveRuntimeBaseUrl,
} from '../../src/agent/agent-runtime.service'

/**
 * §6/§7.3 — the API's client for the eve agent runtime. Unit lane: no
 * database, no network. The eve channel HTTP contract is the contract.
 */

const env = (overrides: Record<string, string> = {}) => ({
  AIPMS_AGENT_EVE_URL: 'http://127.0.0.1:4274',
  AIPMS_AGENT_ACCESS_TOKEN: 'operator-secret',
  ...overrides,
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('resolveRuntimeBaseUrl', () => {
  it('accepts a bare origin and strips the eve route prefix', () => {
    expect(resolveRuntimeBaseUrl('http://127.0.0.1:4274')).toBe(
      'http://127.0.0.1:4274',
    )
    expect(resolveRuntimeBaseUrl('http://127.0.0.1:4274/')).toBe(
      'http://127.0.0.1:4274',
    )
    expect(resolveRuntimeBaseUrl('http://127.0.0.1:4274/eve/v1')).toBe(
      'http://127.0.0.1:4274',
    )
  })

  it('refuses credentials and non-http schemes', () => {
    expect(() =>
      resolveRuntimeBaseUrl('http://user:pass@127.0.0.1:4274'),
    ).toThrow(AgentRuntimeError)
    expect(() => resolveRuntimeBaseUrl('ftp://example.com')).toThrow(
      AgentRuntimeError,
    )
    expect(() => resolveRuntimeBaseUrl('not a url')).toThrow(AgentRuntimeError)
  })
})

describe('AgentRuntimeService', () => {
  it('reports whether the runtime and its credential are configured', () => {
    const service = new AgentRuntimeService()
    expect(service.isConfigured(env())).toBe(true)
    expect(service.isConfigured(env({ AIPMS_AGENT_EVE_URL: '' }))).toBe(false)
    expect(service.isConfigured(env({ AIPMS_AGENT_ACCESS_TOKEN: '' }))).toBe(
      false,
    )
  })

  it('wakes the agent with the operator bearer and an operation id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { ok: true, sessionId: 'wrun_A', deliveryId: 'delivery_A' },
          202,
        ),
      )
    const service = new AgentRuntimeService(fetchMock)

    await expect(
      service.wake(
        { message: 'requisition approved', operationId: 'wake:evt-1' },
        env(),
      ),
    ).resolves.toEqual({ sessionId: 'wrun_A', deliveryId: 'delivery_A' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:4274/eve/v1/session')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer operator-secret',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      message: 'requisition approved',
      operationId: 'wake:evt-1',
    })
    expect(init?.redirect).toBe('error')
  })

  it('retries an ambiguous delivery with the same operation id', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, sessionId: 'wrun_B' }, 202),
      )
    const service = new AgentRuntimeService(fetchMock)

    await expect(
      service.wake({ message: 'wake', operationId: 'wake:evt-2' }, env()),
    ).resolves.toEqual({ sessionId: 'wrun_B', deliveryId: undefined })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(
      (call) => JSON.parse(String(call[1]?.body)).operationId,
    )
    expect(bodies).toEqual(['wake:evt-2', 'wake:evt-2'])
  })

  it('does not replay a refusal the runtime will not accept twice', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'bad request' }, 400))
    const service = new AgentRuntimeService(fetchMock)

    await expect(
      service.wake({ message: 'wake', operationId: 'wake:evt-3' }, env()),
    ).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never leaks the operator credential through an error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('denied operator-secret', { status: 401 }),
      )
    const service = new AgentRuntimeService(fetchMock)

    const error = await service
      .wake({ message: 'wake', operationId: 'wake:evt-4' }, env())
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect((error as Error).message).not.toContain('operator-secret')
    expect((error as Error).message).toContain('[redacted]')
  })

  it('refuses a malformed session response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }, 202))
    const service = new AgentRuntimeService(fetchMock)

    await expect(
      service.wake({ message: 'wake', operationId: 'wake:evt-5' }, env()),
    ).rejects.toThrow(/malformed/)
  })

  it('refuses an empty message and an invalid operation id', async () => {
    const service = new AgentRuntimeService(vi.fn<typeof fetch>())
    await expect(
      service.wake({ message: '   ', operationId: 'wake:evt-6' }, env()),
    ).rejects.toThrow(/empty/)
    await expect(
      service.wake({ message: 'wake', operationId: 'bad id' }, env()),
    ).rejects.toThrow(/operationId/)
  })

  it('probes health without the operator credential', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, status: 'ready', workflowId: 'wf_1' }),
      )
    const service = new AgentRuntimeService(fetchMock)

    await expect(service.health(env())).resolves.toEqual({
      ok: true,
      status: 'ready',
      workflowId: 'wf_1',
    })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:4274/eve/v1/health')
    expect(init?.headers).not.toHaveProperty('authorization')
  })
})
