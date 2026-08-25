import { createHash } from 'node:crypto'

/**
 * §8.2 email intake channel — pure, unit-testable mapping of a parsed IMAP
 * message to the normalized IntakeDocument payload. No I/O and no LLM here;
 * the polling service (intake-imap.service) supplies parsed messages from
 * imapflow + mailparser and this module decides what is stored and how the
 * document dedupes across re-delivery ([channel, contentHash]).
 */

export const EMAIL_IMAP_CHANNEL = 'EMAIL_IMAP'

/** Attachments larger than this are recorded by hash/metadata only. */
export const DEFAULT_ATTACHMENT_INLINE_MAX_BYTES = 2_097_152 // 2 MiB

/** Loose shape of what we consume from mailparser's ParsedMail. */
export interface ParsedMailLike {
  messageId?: string | false
  from?: { value?: Array<{ address?: string; name?: string }> }
  to?: {
    value?: Array<{ address?: string; name?: string }>
    text?: string
  } | null
  subject?: string
  date?: Date | string
  text?: string
  html?: string | false
  attachments?: Array<{
    filename?: string
    contentType?: string
    size?: number
    content: Buffer
  }>
}

export interface RawAttachment {
  filename: string | null
  contentType: string | null
  size: number
  sha256: string
  /** base64 body — present only when within the inline byte cap */
  contentBase64?: string
}

export interface RawPayload {
  headers: {
    messageId: string | null
    from: string | null
    fromName: string | null
    to: string | null
    subject: string
    date: string | null
  }
  textBody: string | null
  attachments: RawAttachment[]
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** First RFC-5322 address of a parsed header value (lower-cased). */
export function senderAddress(mail: ParsedMailLike): string | null {
  const first = mail.from?.value?.[0]?.address?.trim().toLowerCase()
  return first || null
}

function headerDate(date: Date | string | undefined): string | null {
  if (!date) return null
  if (date instanceof Date) return date.toISOString()
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? String(date) : parsed.toISOString()
}

/**
 * Build the `raw` JSON stored on the IntakeDocument: header subset, text
 * body, and attachment metadata. Attachment bodies are inlined as base64 up
 * to `inlineMaxBytes` each (default 2 MiB); larger ones keep filename/type/
 * size/hash only so a poison attachment cannot bloat Postgres.
 */
export function buildRawPayload(
  mail: ParsedMailLike,
  inlineMaxBytes = DEFAULT_ATTACHMENT_INLINE_MAX_BYTES,
): RawPayload {
  const attachments = (mail.attachments ?? []).map((att) => {
    const meta: RawAttachment = {
      filename: att.filename ?? null,
      contentType: att.contentType ?? null,
      size: att.size ?? att.content.byteLength,
      sha256: sha256(att.content),
    }
    if (meta.size <= inlineMaxBytes) {
      meta.contentBase64 = att.content.toString('base64')
    }
    return meta
  })

  return {
    headers: {
      messageId: mail.messageId ? String(mail.messageId) : null,
      from: senderAddress(mail),
      fromName: mail.from?.value?.[0]?.name ?? null,
      to:
        mail.to?.text ??
        mail.to?.value?.map((v) => v.address).join(', ') ??
        null,
      subject: mail.subject ?? '',
      date: headerDate(mail.date),
    },
    textBody: mail.text?.slice(0, 100_000) ?? null,
    attachments,
  }
}

/**
 * Content hash for [channel, contentHash] dedupe. The Message-ID header is
 * the stable identity of one email across re-delivery; when absent (rare,
 * malformed senders) we fall back to a hash over canonical content so an
 * exact duplicate still dedupes while distinct mails never collide.
 */
export function contentHashFor(
  mail: ParsedMailLike,
  raw: RawPayload = buildRawPayload(mail),
): string {
  const messageId = mail.messageId ? String(mail.messageId).trim() : ''
  if (messageId) return sha256(messageId)

  const canonical = JSON.stringify({
    from: raw.headers.from,
    subject: raw.headers.subject,
    date: raw.headers.date,
    bodySha256: raw.textBody ? sha256(raw.textBody) : null,
    attachments: raw.attachments.map((a) => a.sha256),
  })
  return sha256(canonical)
}

/**
 * Defensive intake (§8.2): resolve the sender against the vendor master.
 * A sender matches when it equals the vendor's primary email or appears in
 * its verified contact channels ({ verifiedEmails: [...] }). Unmatched
 * senders still enter the queue with senderId null — they are flagged for
 * review downstream rather than dropped, so onboarding a new supplier is
 * not blocked by ingestion.
 */
export function matchVendorSender(
  email: string | null,
  vendors: Array<{
    id: string
    email: string | null
    contactChannels: unknown
  }>,
): string | null {
  if (!email) return null
  const needle = email.toLowerCase()
  for (const vendor of vendors) {
    if ((vendor.email ?? '').toLowerCase() === needle) return vendor.id
    const channels = (vendor.contactChannels ?? {}) as {
      verifiedEmails?: unknown
    }
    if (
      Array.isArray(channels.verifiedEmails) &&
      channels.verifiedEmails.some(
        (e) => typeof e === 'string' && e.toLowerCase() === needle,
      )
    ) {
      return vendor.id
    }
  }
  return null
}
