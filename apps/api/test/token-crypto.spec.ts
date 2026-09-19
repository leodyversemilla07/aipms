import { describe, expect, it } from 'vitest'
import {
  decryptSecret,
  encryptSecret,
  secretNeedsRotation,
} from '../src/erp/token-crypto'

const oldSecret = 'old-token-encryption-secret-at-least-32-characters'
const newSecret = 'new-token-encryption-secret-at-least-32-characters'

describe('ERP token envelope encryption', () => {
  it('round-trips authenticated v2 ciphertext without exposing plaintext', () => {
    const env = {
      AIPMS_TOKEN_ENCRYPTION_SECRET: oldSecret,
    } as NodeJS.ProcessEnv
    const encrypted = encryptSecret('refresh-token-value', env)
    expect(encrypted).toMatch(/^v2\.[a-f0-9]{16}\./)
    expect(encrypted).not.toContain('refresh-token-value')
    expect(decryptSecret(encrypted, env)).toBe('refresh-token-value')
    expect(secretNeedsRotation(encrypted, env)).toBe(false)
  })

  it('supports an explicit previous key during online rotation', () => {
    const oldEnv = {
      AIPMS_TOKEN_ENCRYPTION_SECRET: oldSecret,
    } as NodeJS.ProcessEnv
    const encrypted = encryptSecret('access-token-value', oldEnv)
    const rotatingEnv = {
      AIPMS_TOKEN_ENCRYPTION_SECRET: newSecret,
      AIPMS_TOKEN_ENCRYPTION_PREVIOUS_SECRET: oldSecret,
    } as NodeJS.ProcessEnv
    expect(decryptSecret(encrypted, rotatingEnv)).toBe('access-token-value')
    expect(secretNeedsRotation(encrypted, rotatingEnv)).toBe(true)
    const rotated = encryptSecret(
      decryptSecret(encrypted, rotatingEnv),
      rotatingEnv,
    )
    expect(secretNeedsRotation(rotated, rotatingEnv)).toBe(false)
  })

  it('rejects missing keys and tampered ciphertext', () => {
    const env = {
      AIPMS_TOKEN_ENCRYPTION_SECRET: oldSecret,
    } as NodeJS.ProcessEnv
    const encrypted = encryptSecret('secret', env)
    expect(() =>
      decryptSecret(encrypted, {
        AIPMS_TOKEN_ENCRYPTION_SECRET: newSecret,
      } as NodeJS.ProcessEnv),
    ).toThrow(/key is not configured/)
    expect(() => decryptSecret(`${encrypted.slice(0, -2)}xx`, env)).toThrow()
    expect(() =>
      encryptSecret('secret', { NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/required in production/)
  })
})
