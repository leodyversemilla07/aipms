import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { db } from '@workspace/db'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import {
  buildRawPayload,
  contentHashFor,
  EMAIL_IMAP_CHANNEL,
  matchVendorSender,
  senderAddress,
} from './imap-message'
import { IntakeService } from './intake.service'

/**
 * §8.2 email intake — IMAP polling channel (the "default, highest coverage"
 * ingestion wire: any supplier can email, zero onboarding). The service
 * polls the org's own mailbox on an interval, ingests unseen messages into
 * the normalized intake queue, and marks them seen only after a successful
 * ingest so a crash between fetch and store re-processes rather than loses.
 *
 * Defensive posture per §8.2:
 * - Dedupe is structural: [EMAIL_IMAP, sha256(messageId)] via the intake
 *   queue's unique constraint — re-polls and server re-deliveries are
 *   idempotent no-ops.
 * - Senders are resolved against the vendor master (primary email or
 *   verified contact channels); unknown senders enter the queue with
 *   senderId null and are visible for review instead of silently dropped.
 * - Transport-layer authenticity (SPF/DKIM/DMARC) is enforced by the mail
 *   exchanger before delivery to this mailbox; this consumer treats the
 *   mailbox as the trust boundary.
 *
 * Disabled unless AIPMS_IMAP_HOST + AIPMS_IMAP_USER + AIPMS_IMAP_PASSWORD
 * are configured, mirroring how the event relay and agent drain loop gate
 * themselves in single-tenant deployment.
 */

export interface ImapIntakeConfig {
  host: string
  port: number
  user: string
  password: string
  tls: boolean
  mailbox: string
  intervalMs: number
  markSeen: boolean
}

export function resolveImapConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImapIntakeConfig | null {
  const host = env.AIPMS_IMAP_HOST?.trim()
  const user = env.AIPMS_IMAP_USER?.trim()
  const password = env.AIPMS_IMAP_PASSWORD
  if (!host || !user || !password) return null

  return {
    host,
    port: Number(env.AIPMS_IMAP_PORT ?? 993) || 993,
    user,
    password,
    tls: (env.AIPMS_IMAP_TLS ?? 'true') !== 'false',
    mailbox: env.AIPMS_IMAP_MAILBOX?.trim() || 'INBOX',
    intervalMs: Number(env.AIPMS_IMAP_INTERVAL_MS ?? 60_000) || 60_000,
    markSeen: (env.AIPMS_IMAP_MARK_SEEN ?? 'true') !== 'false',
  }
}

@Injectable()
export class IntakeImapService implements OnModuleInit, OnModuleDestroy {
  private config: ImapIntakeConfig | null = resolveImapConfig()
  private interval: ReturnType<typeof setInterval> | null = null
  private polling = false
  /** Set by tests to drive poll cycles without real timers/IMAP servers. */
  pollOnce?: () => Promise<void>

  constructor(private readonly intake: IntakeService) {}

  onModuleInit() {
    if (!this.config) {
      console.log(
        '[imap-intake] disabled — AIPMS_IMAP_HOST/USER/PASSWORD not set',
      )
      return
    }
    // Never log or retain the credential beyond this struct.
    console.log(
      `[imap-intake] polling ${this.config.user}@${this.config.host}:${this.config.port}/${this.config.mailbox} every ${this.config.intervalMs}ms`,
    )
    this.interval = setInterval(() => void this.poll(), this.config.intervalMs)
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval)
  }

  async poll(): Promise<void> {
    if (!this.config || this.polling) return
    this.polling = true
    try {
      await (this.pollOnce ?? this.pollMailbox)(this.config)
    } catch (error) {
      // Fail visible but never kill the loop — next tick retries.
      console.error('[imap-intake] poll failed:', error)
    } finally {
      this.polling = false
    }
  }

  /** Public so integration tests can drive a single cycle against a stub. */
  async pollMailbox(config: ImapIntakeConfig): Promise<void> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      auth: { user: config.user, pass: config.password },
      secure: config.tls,
      logger: false,
      emitLogs: false,
    })

    try {
      await client.connect()
      const lock = await client.getMailboxLock(config.mailbox)

      try {
        // Vendor master is re-read each cycle so qualification/contact
        // changes apply without a restart (single-tenant scale: cheap).
        const vendors = await db.vendor.findMany({
          select: { id: true, email: true, contactChannels: true },
        })

        for await (const message of client.fetch(
          { seen: false },
          { source: true, uid: true },
        )) {
          try {
            if (!message.source) {
              console.error(
                `[imap-intake] uid ${message.uid} has no source; skipping`,
              )
              continue
            }
            const ingested = await this.ingestMessage(message.source, vendors)
            if (ingested && config.markSeen) {
              await client.messageFlagsAdd({ uid: message.uid }, ['\\Seen'], {
                uid: true,
              })
            }
          } catch (error) {
            console.error(
              `[imap-intake] failed to ingest uid ${message.uid}:`,
              error,
            )
          }
        }
      } finally {
        lock.release()
      }
    } finally {
      await client.logout().catch(() => undefined)
    }
  }

  /** Parse one raw RFC-822 source and push it through the intake queue. */
  async ingestMessage(
    source: Buffer,
    vendors: Array<{
      id: string
      email: string | null
      contactChannels: unknown
    }>,
  ): Promise<boolean> {
    const mail = await simpleParser(source)
    const raw = buildRawPayload(mail)
    const contentHash = contentHashFor(mail, raw)
    const from = senderAddress(mail)

    const doc = await this.intake.ingest({
      channel: EMAIL_IMAP_CHANNEL,
      contentHash,
      senderId: matchVendorSender(from, vendors),
      raw,
    })
    // ingest() resolves duplicates idempotently; report whether this was new
    // so the caller knows whether to spend a \\Seen flag (harmless either way).
    return Boolean(doc.id)
  }
}
