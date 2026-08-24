/**
 * §8.5 QuickBooks Online connector — the concrete v1 adapter over the
 * governed journal manifest.
 *
 * Ownership boundary (anti-pitfall rule): aipms publishes procurement
 * transaction state; QBO owns master data and final posting. The connector
 * translates a verified journal manifest into QBO JournalEntry lines and
 * feeds the resulting document id back through `erp.acknowledge`.
 *
 * HTTP is an injected seam (`type FetchLike`) so tests run without network.
 * Amounts leave as decimal major units — minor-unit integers never cross
 * the API boundary unconverted.
 */

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export interface QboConfig {
  clientId: string
  clientSecret: string
  /** 'sandbox' (default) | 'production' */
  environment: string
}

export function qboConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): QboConfig {
  return {
    clientId: env.QBO_CLIENT_ID ?? '',
    clientSecret: env.QBO_CLIENT_SECRET ?? '',
    environment:
      env.QBO_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
  }
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  /** Seconds until access-token expiry. */
  expiresIn: number
}

export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

export function apiBase(config: QboConfig): string {
  return config.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'
}

/** Intuit OAuth2 authorize URL with CSRF state. */
export function buildAuthorizeUrl(
  config: QboConfig,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'com.intuit.quickbooks.accounting')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

interface RawToken {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
}

function parseToken(raw: RawToken): TokenResponse {
  if (
    typeof raw.access_token !== 'string' ||
    typeof raw.refresh_token !== 'string' ||
    typeof raw.expires_in !== 'number'
  ) {
    throw new Error('Malformed token response from Intuit OAuth')
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresIn: raw.expires_in,
  }
}

async function postForm(
  fetchImpl: FetchLike,
  config: QboConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`Intuit token endpoint returned ${res.status}`)
  }
  return parseToken((await res.json()) as RawToken)
}

export function exchangeCode(
  config: QboConfig,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  return postForm(
    fetchImpl,
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  )
}

export function refreshToken(
  config: QboConfig,
  refreshTokenValue: string,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  return postForm(
    fetchImpl,
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
    }),
  )
}

// ── JournalEntry construction ────────────────────────────────────────────

export interface JeLineInput {
  /** aipms chart code ('2010' | '2020' | '1010') — must be mapped. */
  accountCode: string
  side: 'debit' | 'credit'
  amountMinor: number
  currencyCode: string
  memo: string
}

export interface JeManifestInput {
  runNumber: string
  executedAtIso: string
  lines: JeLineInput[]
}

export interface QboJournalEntryPayload {
  DocNumber: string
  TxnDate: string // YYYY-MM-DD
  Line: {
    DetailType: 'JournalEntryLineDetail'
    Amount: number
    Description?: string
    JournalEntryLineDetail: {
      PostingType: 'Debit' | 'Credit'
      AccountRef: { value: string; name?: string }
      CurrencyRef?: { value: string }
    }
  }[]
}

/**
 * Map aipms chart codes onto QBO account ids and build the API payload.
 * Throws when any code lacks a mapping — a silent misposting is worse than
 * a refused one.
 */
export function buildJournalEntry(
  input: JeManifestInput,
  accountMap: Record<string, string>,
): QboJournalEntryPayload {
  const Line = input.lines.map((l) => {
    const qboAccountId = accountMap[l.accountCode]
    if (!qboAccountId) {
      throw new Error(
        `No QuickBooks account mapped for aipms account ${l.accountCode} — configure the chart map before pushing`,
      )
    }
    return {
      DetailType: 'JournalEntryLineDetail' as const,
      Amount: l.amountMinor / 100,
      Description: l.memo,
      JournalEntryLineDetail: {
        PostingType: (l.side === 'debit' ? 'Debit' : 'Credit') as
          | 'Debit'
          | 'Credit',
        AccountRef: { value: qboAccountId },
        ...(l.currencyCode !== 'USD'
          ? { CurrencyRef: { value: l.currencyCode } }
          : {}),
      },
    }
  })
  return {
    DocNumber: input.runNumber,
    TxnDate: input.executedAtIso.slice(0, 10),
    Line,
  }
}

export interface QboQueryResponse {
  QueryResponse?: {
    Account?: {
      Id: string
      Name: string
      AccountType: string
      Active: boolean
    }[]
  }
}

/** List active accounts for the mapping UI (chart of accounts pull). */
export async function listAccounts(
  config: QboConfig,
  realmId: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<{ id: string; name: string; type: string }[]> {
  const res = await fetchImpl(
    `${apiBase(config)}/v3/company/${realmId}/query?query=${encodeURIComponent(
      'select * from Account where Active = true maxresults 500',
    )}`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    },
  )
  if (!res.ok) throw new Error(`QBO account query returned ${res.status}`)
  const data = (await res.json()) as QboQueryResponse
  return (data.QueryResponse?.Account ?? []).map((a) => ({
    id: a.Id,
    name: a.Name,
    type: a.AccountType,
  }))
}

export async function createJournalEntry(
  config: QboConfig,
  realmId: string,
  accessToken: string,
  payload: QboJournalEntryPayload,
  fetchImpl: FetchLike,
): Promise<{ id: string }> {
  const res = await fetchImpl(
    `${apiBase(config)}/v3/company/${realmId}/journalentry?minorversion=65`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    },
  )
  const body = (await res.json()) as {
    JournalEntry?: { Id?: unknown }
    Fault?: { Error?: { Message?: unknown }[] }
  }
  if (!res.ok) {
    const message =
      body.Fault?.Error?.map((e) => String(e.Message)).join('; ') ??
      `QBO returned ${res.status}`
    throw new Error(message)
  }
  const id = body.JournalEntry?.Id
  if (typeof id !== 'string')
    throw new Error('QBO response missing JournalEntry.Id')
  return { id }
}
