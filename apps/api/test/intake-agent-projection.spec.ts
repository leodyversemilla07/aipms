import { describe, expect, it } from 'vitest'
import {
  projectIntakeValueForAgent,
  redactIntakeText,
} from '../src/intake/intake-agent-projection'

describe('prompt-safe intake projection', () => {
  it('redacts labeled bank and payment numbers while preserving invoice data', () => {
    const text = [
      'Invoice INV-2026-0042',
      'Total PHP 12,500.00',
      'Bank account number: 1234 5678 9012 3456',
      'IBAN: GB82 WEST 1234 5698 7654 32',
    ].join('\n')
    const redacted = redactIntakeText(text)
    expect(redacted).toContain('INV-2026-0042')
    expect(redacted).toContain('PHP 12,500.00')
    expect(redacted).not.toContain('1234 5678 9012 3456')
    expect(redacted).not.toContain('GB82 WEST 1234 5698 7654 32')
  })

  it('removes sensitive object fields and binary attachment content', () => {
    const projected = projectIntakeValueForAgent({
      number: 'INV-42',
      vendorId: 'vendor-1',
      bankAccount: '001122334455',
      apiToken: 'secret-token',
      attachments: [
        {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          contentBase64: 'very-large-sensitive-body',
          sha256: 'safe-hash',
        },
      ],
    }) as Record<string, unknown>
    expect(projected.number).toBe('INV-42')
    expect(projected.bankAccount).toBe('[REDACTED]')
    expect(projected.apiToken).toBe('[REDACTED]')
    expect(JSON.stringify(projected)).not.toContain('very-large-sensitive-body')
    expect(JSON.stringify(projected)).toContain('safe-hash')
  })
})
