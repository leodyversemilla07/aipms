import { createHmac } from 'node:crypto'
import {
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { ErpConnectionModel as ErpConnection } from '@workspace/db'
import { db } from '@workspace/db'
import {
  buildAuthorizeUrl,
  buildJournalEntry,
  createJournalEntry,
  exchangeCode,
  type FetchLike,
  type JeManifestInput,
  listAccounts,
  type QboConfig,
  qboConfigFromEnv,
  refreshToken as refreshAccessToken,
} from './qbo-client'
import { decryptSecret, encryptSecret } from './token-crypto'

const PROVIDER = 'quickbooks'
const STATE_TTL_MS = 10 * 60 * 1000

export interface ConnectionView {
  connected: boolean
  realmId: string | null
  environment: string
  /** aipms account code → QBO account id */
  accountMap: Record<string, string>
  cachedAccounts: { id: string; name: string; type: string }[]
}

interface ConnectionSettings {
  accountMap?: Record<string, string>
  cachedAccounts?: { id: string; name: string; type: string }[]
}

/**
 * QuickBooks Online connection lifecycle + journal publishing.
 * HTTP is injected for tests; tokens are encrypted at rest and refreshed
 * lazily before use.
 */
@Injectable()
export class QboService {
  private readonly fetchImpl: FetchLike

  /**
   * Transport is injected in tests; at runtime Nest passes undefined here
   * (@Optional on an unresolvable token) and we fall back to global fetch.
   */
  constructor(@Optional() fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init))
  }

  get config(): QboConfig {
    return qboConfigFromEnv()
  }

  get configured(): boolean {
    return this.config.clientId !== '' && this.config.clientSecret !== ''
  }

  private get redirectUri(): string {
    const base =
      process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
    return process.env.QBO_REDIRECT_URI ?? `${base}/api/erp/qbo/callback`
  }

  private signState(expiresAtMs: number): string {
    const secret = process.env.BETTER_AUTH_SECRET ?? 'aipms-dev-only-secret'
    return createHmac('sha256', secret)
      .update(String(expiresAtMs))
      .digest('hex')
  }

  /**
   * Authorize URL with an HMAC-signed, expiring state parameter (CSRF).
   * The browser follows it; Intuit redirects back to our callback route.
   */
  authorizeUrl(): string {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'QuickBooks connector not configured (set QBO_CLIENT_ID / QBO_CLIENT_SECRET)',
      )
    }
    const expiresAt = Date.now() + STATE_TTL_MS
    const state = `${expiresAt}.${this.signState(expiresAt)}`
    return buildAuthorizeUrl(this.config, this.redirectUri, state)
  }

  private assertState(state: string): void {
    const [expRaw, sig] = state.split('.')
    const exp = Number(expRaw)
    if (!exp || !sig || Number.isNaN(exp)) {
      throw new ConflictException('Malformed OAuth state')
    }
    if (Date.now() > exp) throw new ConflictException('OAuth state expired')
    if (this.signState(exp) !== sig) {
      throw new ConflictException('OAuth state signature mismatch')
    }
  }

  async handleCallback(
    code: string,
    realmId: string,
    state: string,
  ): Promise<void> {
    this.assertState(state)
    if (!realmId) throw new ConflictException('Missing realmId in callback')
    const token = await exchangeCode(
      this.config,
      code,
      this.redirectUri,
      this.fetchImpl,
    )

    const existing = await db.erpConnection.findUnique({
      where: { provider_realmId: { provider: PROVIDER, realmId } },
    })
    const data = {
      accessTokenEnc: encryptSecret(token.accessToken),
      refreshTokenEnc: encryptSecret(token.refreshToken),
      expiresAt: new Date(Date.now() + token.expiresIn * 1000),
      status: 'connected',
    }
    await db.erpConnection.upsert({
      where: { provider_realmId: { provider: PROVIDER, realmId } },
      create: { provider: PROVIDER, realmId, ...data },
      update: data,
    })
    void existing
  }

  async status(): Promise<ConnectionView> {
    const conn = await db.erpConnection.findFirst({
      where: { provider: PROVIDER, status: 'connected' },
    })
    const settings = (conn?.settings ?? {}) as ConnectionSettings
    return {
      connected: !!conn,
      realmId: conn?.realmId ?? null,
      environment: this.config.environment,
      accountMap: settings.accountMap ?? {},
      cachedAccounts: settings.cachedAccounts ?? [],
    }
  }

  async disconnect(): Promise<void> {
    await db.erpConnection.updateMany({
      where: { provider: PROVIDER },
      data: { status: 'disconnected' },
    })
  }

  private async requireConnection(): Promise<ErpConnection> {
    const conn = await db.erpConnection.findFirst({
      where: { provider: PROVIDER, status: 'connected' },
    })
    if (!conn) {
      throw new ConflictException(
        'QuickBooks is not connected — start the OAuth flow first',
      )
    }
    return conn
  }

  /** Refresh the access token lazily (5-minute safety margin). */
  private async freshToken(
    conn: ErpConnection,
  ): Promise<{ conn: ErpConnection; accessToken: string }> {
    let current = conn
    if (current.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      const refreshed = await refreshAccessToken(
        this.config,
        decryptSecret(current.refreshTokenEnc),
        this.fetchImpl,
      )
      const updated = await db.erpConnection.update({
        where: { id: current.id },
        data: {
          accessTokenEnc: encryptSecret(refreshed.accessToken),
          refreshTokenEnc: encryptSecret(refreshed.refreshToken),
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      })
      current = updated
    }
    return { conn: current, accessToken: decryptSecret(current.accessTokenEnc) }
  }

  /** Chart-of-accounts pull — QBO owns master data (§8.5 ownership rule). */
  async syncAccounts(): Promise<{ id: string; name: string; type: string }[]> {
    const conn = await this.requireConnection()
    const { accessToken } = await this.freshToken(conn)
    const accounts = await listAccounts(
      this.config,
      conn.realmId,
      accessToken,
      this.fetchImpl,
    )
    const settings = (conn.settings ?? {}) as ConnectionSettings
    await db.erpConnection.update({
      where: { id: conn.id },
      data: { settings: { ...settings, cachedAccounts: accounts } },
    })
    return accounts
  }

  async setAccountMap(
    accountMap: Record<string, string>,
  ): Promise<Record<string, string>> {
    const conn = await this.requireConnection()
    const settings = (conn.settings ?? {}) as ConnectionSettings
    await db.erpConnection.update({
      where: { id: conn.id },
      data: { settings: { ...settings, accountMap } },
    })
    return accountMap
  }

  /**
   * Publish one verified journal manifest to QBO. The caller (router) owns
   * manifest verification and the acknowledgement write-back; here we only
   * translate and post. Returns the QBO JournalEntry document id.
   */
  async postJournal(
    manifestJson: string,
  ): Promise<{ qboJournalEntryId: string }> {
    const conn = await this.requireConnection()
    const { accessToken } = await this.freshToken(conn)
    const manifest = JSON.parse(manifestJson) as {
      runNumber: string
      executedAt: string
      currencyCode: string
      entries: {
        account: string
        side: 'debit' | 'credit'
        amountMinor: number
        currencyCode: string
        memo: string
      }[]
    }
    const input: JeManifestInput = {
      runNumber: manifest.runNumber,
      executedAtIso: manifest.executedAt,
      lines: manifest.entries.map((e) => ({
        accountCode: e.account,
        side: e.side,
        amountMinor: e.amountMinor,
        currencyCode: e.currencyCode,
        memo: e.memo,
      })),
    }
    const settings = (conn.settings ?? {}) as ConnectionSettings
    const payload = buildJournalEntry(input, settings.accountMap ?? {})
    try {
      const { id } = await createJournalEntry(
        this.config,
        conn.realmId,
        accessToken,
        payload,
        this.fetchImpl,
      )
      return { qboJournalEntryId: id }
    } catch (err) {
      throw new ServiceUnavailableException(
        `QuickBooks rejected the journal for ${manifest.runNumber}: ${(err as Error).message}`,
      )
    }
  }
}
