import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

/**
 * Token encryption at rest for ERP connections. AES-256-GCM keyed by
 * SHA-256 of the instance's BETTER_AUTH_SECRET (already a managed secret);
 * output layout: base64(iv) '.' base64(tag) '.' base64(ciphertext).
 *
 * This is a v1 seam — an HSM/KMS-managed key swaps in behind the same two
 * functions without touching callers.
 */

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET ?? 'aipms-dev-only-secret'
  return createHash('sha256').update(secret).digest()
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join('.')
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.')
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
