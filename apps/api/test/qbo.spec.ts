import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { QboService } from '../src/erp/qbo.service'
import type { FetchLike } from '../src/erp/qbo-client'
import {
  AUTHORIZE_URL,
  buildAuthorizeUrl,
  buildJournalEntry,
  createJournalEntry,
  exchangeCode,
  refreshToken,
} from '../src/erp/qbo-client'
import { decryptSecret, encryptSecret } from '../src/erp/token-crypto'

process.env.BETTER_AUTH_SECRET = 'test-secret'
process.env.QBO_CLIENT_ID = 'cid'
process.env.QBO_CLIENT_SECRET = 'csecret'

const config = {
  clientId: 'cid',
  clientSecret: 'csecret',
  environment: 'sandbox' as const,
}

const createdConnections: string[] = []

afterAll(async () => {
  await db.erpConnection.deleteMany({
    where: { id: { in: createdConnections } },
  })
  await db.$disconnect()
})

/** Scriptable fetch mock: one canned response per call, recorded. */
function fetchMock(responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: { method: string; body?: string } }[] = []
  const impl: FetchLike = async (url, init) => {
    const i = calls.length
    calls.push({ url, init })
    const r = responses[i] ?? { status: 500, body: {} }
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    }
  }
  return { impl, calls }
}

describe('token encryption', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('s3cret-token')
    expect(enc).not.toContain('s3cret-token')
    expect(decryptSecret(enc)).toBe('s3cret-token')
  })

  it('rejects tampered payloads', () => {
    const enc = encryptSecret('token')
    const [iv, tag, data] = enc.split('.')
    const tampered = `${iv}.${tag}.${data.slice(0, -2)}AA`
    expect(() => decryptSecret(tampered)).toThrow()
  })
})

describe('QBO OAuth helpers (mocked transport)', () => {
  it('builds the authorize URL with scope and state', () => {
    const url = new URL(
      buildAuthorizeUrl(config, 'https://api.example/callback', 'state123'),
    )
    expect(url.origin + url.pathname).toBe(AUTHORIZE_URL)
    expect(url.searchParams.get('scope')).toBe(
      'com.intuit.quickbooks.accounting',
    )
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example/callback',
    )
    expect(url.searchParams.get('state')).toBe('state123')
  })

  it('exchanges a code and refreshes tokens', async () => {
    const { impl, calls } = fetchMock([
      { body: { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 } },
      { body: { access_token: 'at2', refresh_token: 'rt2', expires_in: 1800 } },
    ])
    const first = await exchangeCode(config, 'the-code', 'https://cb', impl)
    expect(first).toEqual({
      accessToken: 'at1',
      refreshToken: 'rt1',
      expiresIn: 3600,
    })
    expect(calls[0]?.init.body).toContain('grant_type=authorization_code')

    const second = await refreshToken(config, 'rt1', impl)
    expect(second.accessToken).toBe('at2')
    expect(calls[1]?.init.body).toContain('grant_type=refresh_token')
  })
})

describe('buildJournalEntry (pure)', () => {
  const lines = [
    {
      accountCode: '2010',
      side: 'debit' as const,
      amountMinor: 112_000,
      currencyCode: 'PHP',
      memo: 'AP INV-1',
    },
    {
      accountCode: '1010',
      side: 'credit' as const,
      amountMinor: 107_000,
      currencyCode: 'PHP',
      memo: 'Payment INV-1',
    },
  ]

  it('maps chart codes onto QBO account ids and converts to major units', () => {
    const je = buildJournalEntry(
      { runNumber: 'PR-1', executedAtIso: '2026-08-23T00:00:00Z', lines },
      { '2010': '84', '1010': '90' },
    )
    expect(je.DocNumber).toBe('PR-1')
    expect(je.TxnDate).toBe('2026-08-23')
    expect(je.Line[0]?.Amount).toBe(1120)
    expect(je.Line[0]?.JournalEntryLineDetail.PostingType).toBe('Debit')
    expect(je.Line[0]?.JournalEntryLineDetail.AccountRef.value).toBe('84')
    expect(je.Line[0]?.JournalEntryLineDetail.CurrencyRef?.value).toBe('PHP')
  })

  it('refuses unmapped accounts instead of silently misposting', () => {
    expect(() =>
      buildJournalEntry(
        { runNumber: 'PR-1', executedAtIso: '2026-08-23T00:00:00Z', lines },
        { '2010': '84' }, // '1010' unmapped
      ),
    ).toThrow(/No QuickBooks account mapped/)
  })
})

describe('QboService connection lifecycle', () => {
  let svc: QboService

  beforeEach(() => {
    svc = new QboService()
  })

  it('mints signed state and completes the callback into a stored connection', async () => {
    const { impl } = fetchMock([
      {
        body: {
          access_token: 'at-cb',
          refresh_token: 'rt-cb',
          expires_in: 3600,
        },
      },
    ])
    // Inject our mock by exercising handleCallback through a subclass-free
    // route: exchangeCode is called with svc's own transport, so swap it.
    ;(svc as unknown as { fetchImpl: FetchLike }).fetchImpl = impl

    const url = new URL(svc.authorizeUrl())
    const state = url.searchParams.get('state') ?? ''

    await svc.handleCallback('auth-code', 'realm-123', state)
    const conn = await db.erpConnection.findUnique({
      where: {
        provider_realmId: { provider: 'quickbooks', realmId: 'realm-123' },
      },
    })
    if (!conn) throw new Error('connection missing')
    createdConnections.push(conn.id)

    expect(conn.status).toBe('connected')
    expect(decryptSecret(conn.accessTokenEnc)).toBe('at-cb')
    expect(decryptSecret(conn.refreshTokenEnc)).toBe('rt-cb')
  })

  it('rejects forged or expired OAuth state', async () => {
    await expect(svc.handleCallback('c', 'r', '999.badsig')).rejects.toThrow(
      /signature|expired|Malformed/i,
    )
  })

  it('posts a journal and surfaces QBO errors verbatim', async () => {
    const { impl, calls } = fetchMock([
      // token is fresh (expires far ahead) → only the JE POST happens
      { body: { JournalEntry: { Id: 'JE-77' } } },
    ])
    ;(svc as unknown as { fetchImpl: FetchLike }).fetchImpl = impl

    const manifest = JSON.stringify({
      runNumber: 'RUN-QBO-1',
      executedAt: '2026-08-23T10:00:00Z',
      currencyCode: 'PHP',
      entries: [
        {
          account: '2010',
          side: 'debit',
          amountMinor: 112_000,
          currencyCode: 'PHP',
          memo: 'AP',
        },
        {
          account: '1010',
          side: 'credit',
          amountMinor: 112_000,
          currencyCode: 'PHP',
          memo: 'Cash',
        },
      ],
    })

    // Seed a connected connection with a map + far-future expiry.
    const existing = await db.erpConnection.findFirst({
      where: { provider: 'quickbooks', realmId: 'realm-123' },
    })
    if (!existing) throw new Error('run the callback test first')
    await db.erpConnection.update({
      where: { id: existing.id },
      data: {
        accessTokenEnc: encryptSecret('fresh-at'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        settings: { accountMap: { '2010': '84', '1010': '90' } },
      },
    })

    const result = await svc.postJournal(manifest)
    expect(result.qboJournalEntryId).toBe('JE-77')
    expect(calls[0]?.url).toContain('/v3/company/realm-123/journalentry')
    const body = JSON.parse(calls[0]?.init.body ?? '{}') as {
      DocNumber: string
      Line: { Amount: number }[]
    }
    expect(body.DocNumber).toBe('RUN-QBO-1')
    expect(body.Line.length).toBe(2)

    // Unmapped code → refused before any network call.
    const bad = JSON.parse(manifest) as typeof manifest
    bad.entries[0]!.account = '9999'
    await expect(svc.postJournal(JSON.stringify(bad))).rejects.toThrow(
      /No QuickBooks account mapped/,
    )
  })

  it('createJournalEntry surfaces QBO fault messages', async () => {
    const { impl } = fetchMock([
      {
        status: 400,
        body: { Fault: { Error: [{ Message: 'balances do not match' }] } },
      },
    ])
    await expect(
      createJournalEntry(
        config,
        'realm-x',
        'token',
        { DocNumber: 'D', TxnDate: '2026-08-23', Line: [] },
        impl,
      ),
    ).rejects.toThrow(/balances do not match/)
  })
})
