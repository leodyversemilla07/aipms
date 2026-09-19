import { afterEach, describe, expect, it, vi } from 'vitest'
import { configuredMessageTransport } from '../src/messaging/messaging.module'
import { LoggingTransport } from '../src/messaging/messaging.service'
import {
  SmtpMessageTransport,
  smtpConfigFromEnv,
} from '../src/messaging/smtp-message.transport'

afterEach(() => vi.unstubAllEnvs())

describe('production message transport', () => {
  it('fails closed when SMTP is not configured', async () => {
    const transport = new SmtpMessageTransport()
    await expect(
      transport.send({
        id: 'message-1',
        to: 'vendor@example.com',
        subject: 'Purchase order',
        body: 'Attached order',
      }),
    ).rejects.toThrow(/Outbound messaging is disabled/)
  })

  it('validates complete TLS SMTP configuration', () => {
    expect(
      smtpConfigFromEnv({
        AIPMS_SMTP_HOST: 'smtp.example.com',
        AIPMS_SMTP_PORT: '587',
        AIPMS_SMTP_FROM: 'Procurement <procurement@example.com>',
        AIPMS_SMTP_USER: 'relay-user',
        AIPMS_SMTP_PASSWORD: 'relay-password',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      messageDomain: 'example.com',
    })
    expect(() =>
      smtpConfigFromEnv({
        AIPMS_SMTP_HOST: 'smtp.example.com',
        AIPMS_SMTP_FROM: 'procurement@example.com',
        AIPMS_SMTP_USER: 'relay-user',
      } as NodeJS.ProcessEnv),
    ).toThrow(/configured together/)
  })

  it('never selects the simulated logger in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(configuredMessageTransport()).toBeInstanceOf(SmtpMessageTransport)
    vi.stubEnv('AIPMS_MESSAGING_TRANSPORT', 'log')
    expect(() => configuredMessageTransport()).toThrow(/forbidden/)
  })

  it('keeps the logger explicit to non-production environments', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AIPMS_MESSAGING_TRANSPORT', 'log')
    expect(configuredMessageTransport()).toBeInstanceOf(LoggingTransport)
  })
})
