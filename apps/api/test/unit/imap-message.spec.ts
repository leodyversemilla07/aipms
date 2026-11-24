import { describe, expect, it } from 'vitest'
import {
  buildRawPayload,
  contentHashFor,
  type ParsedMailLike,
  senderAddress,
} from '../../src/intake/imap-message'

/**
 * §8.2 email intake — pure mapping helpers. This lane runs without a
 * database; the database-backed intake flow is covered in test/imap-intake.
 */

function mail(overrides: Partial<ParsedMailLike> = {}): ParsedMailLike {
  return {
    messageId: '<msg-1@supplier.example>',
    subject: 'Invoice INV-42',
    text: 'Please find attached invoice INV-42.',
    ...overrides,
  }
}

describe('imap-message mapping (§8.2, pure)', () => {
  it('projects recipients from a single address group', () => {
    const raw = buildRawPayload(
      mail({
        to: {
          text: 'ap@acme.example',
          value: [{ address: 'ap@acme.example' }],
        },
      }),
    )
    expect(raw.headers.to).toBe('ap@acme.example')
  })

  it('projects recipients when mailparser returns several address groups', () => {
    const raw = buildRawPayload(
      mail({
        to: [
          {
            text: 'ap@acme.example',
            value: [{ address: 'ap@acme.example' }],
          },
          { value: [{ address: 'ap@globex.example' }] },
        ],
      }),
    )
    expect(raw.headers.to).toBe('ap@acme.example, ap@globex.example')
  })

  it('falls back to the parsed addresses when no header text is present', () => {
    const raw = buildRawPayload(
      mail({ to: { value: [{ address: 'ap@acme.example' }] } }),
    )
    expect(raw.headers.to).toBe('ap@acme.example')
  })

  it('resolves the sender address in lower case', () => {
    expect(
      senderAddress(
        mail({ from: { value: [{ address: 'BILLING@Acme.example' }] } }),
      ),
    ).toBe('billing@acme.example')
    expect(senderAddress(mail())).toBeNull()
  })

  it('hashes by Message-ID when present and by content otherwise', () => {
    const withId = contentHashFor(mail())
    expect(contentHashFor(mail({ subject: 'different' }))).toBe(withId)
    expect(contentHashFor(mail({ messageId: false }))).not.toBe(withId)
  })
})
