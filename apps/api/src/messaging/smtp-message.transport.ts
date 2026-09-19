import { Injectable } from '@nestjs/common'
import nodemailer, { type Transporter } from 'nodemailer'
import type {
  MessageTransport,
  MessageTransportResult,
} from './messaging.service'

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string | null
  password: string | null
  from: string
  messageDomain: string
}

function messageDomain(from: string, configured?: string) {
  const explicit = configured?.trim().toLowerCase()
  if (explicit) return explicit
  const match = /@([^>\s]+)>?$/.exec(from.trim())
  return match?.[1]?.toLowerCase() ?? 'aipms.local'
}

export function smtpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null {
  const host = env.AIPMS_SMTP_HOST?.trim()
  const from = env.AIPMS_SMTP_FROM?.trim()
  const user = env.AIPMS_SMTP_USER?.trim() || null
  const password = env.AIPMS_SMTP_PASSWORD || null
  const configured = [host, from, user, password].some(Boolean)
  if (!configured) return null
  if (!host || !from) {
    throw new Error('SMTP requires AIPMS_SMTP_HOST and AIPMS_SMTP_FROM')
  }
  if (Boolean(user) !== Boolean(password)) {
    throw new Error(
      'AIPMS_SMTP_USER and AIPMS_SMTP_PASSWORD must be configured together',
    )
  }
  const port = Number(env.AIPMS_SMTP_PORT ?? 587)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('AIPMS_SMTP_PORT must be an integer from 1 to 65535')
  }
  const secure =
    (env.AIPMS_SMTP_SECURE ?? (port === 465 ? 'true' : 'false')) === 'true'
  const domain = messageDomain(from, env.AIPMS_SMTP_MESSAGE_DOMAIN)
  if (!/^[a-z0-9.-]+$/.test(domain)) {
    throw new Error('AIPMS_SMTP_MESSAGE_DOMAIN must be a DNS name')
  }
  return {
    host,
    port,
    secure,
    user,
    password,
    from,
    messageDomain: domain,
  }
}

/**
 * Production SMTP relay. Port 465 uses implicit TLS; all other ports require
 * STARTTLS. Certificate verification is never disabled.
 */
@Injectable()
export class SmtpMessageTransport implements MessageTransport {
  private readonly transporter: Transporter | null
  private readonly config: SmtpConfig | null
  private readonly configurationError: Error | null

  constructor() {
    try {
      this.config = smtpConfigFromEnv()
      this.configurationError = null
      this.transporter = this.config
        ? nodemailer.createTransport({
            host: this.config.host,
            port: this.config.port,
            secure: this.config.secure,
            requireTLS: !this.config.secure,
            auth:
              this.config.user && this.config.password
                ? {
                    user: this.config.user,
                    pass: this.config.password,
                  }
                : undefined,
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 30_000,
            tls: {
              minVersion: 'TLSv1.2',
              rejectUnauthorized: true,
            },
          })
        : null
    } catch (error) {
      this.config = null
      this.transporter = null
      this.configurationError =
        error instanceof Error ? error : new Error(String(error))
    }
  }

  async send(message: {
    id: string
    to: string
    subject: string
    body: string
  }): Promise<MessageTransportResult> {
    if (this.configurationError) throw this.configurationError
    if (!this.transporter || !this.config) {
      throw new Error(
        'Outbound messaging is disabled: configure the AIPMS_SMTP_* settings',
      )
    }
    const providerMessageId = `<${message.id}@${this.config.messageDomain}>`
    const result = await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      messageId: providerMessageId,
      headers: {
        'X-AIPMS-Message-ID': message.id,
      },
    })
    if (
      (result.rejected?.length ?? 0) > 0 ||
      (result.accepted?.length ?? 0) === 0
    ) {
      throw new Error('SMTP relay did not accept the intended recipient')
    }
    return { providerMessageId: result.messageId || providerMessageId }
  }
}
