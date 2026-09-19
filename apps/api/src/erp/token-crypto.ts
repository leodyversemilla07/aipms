import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * AES-256-GCM envelope encryption for ERP credentials.
 *
 * v2 payload: `v2.keyId.base64(iv).base64(tag).base64(ciphertext)`.
 * A dedicated current key encrypts new values; an optional previous key keeps
 * existing values readable during rotation. Legacy v1 values (which used the
 * Better Auth secret) remain readable and are rotated on the next QBO use.
 */

function currentSecret(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.AIPMS_TOKEN_ENCRYPTION_SECRET
  if (configured) {
    if (configured.length < 32) {
      throw new Error(
        'AIPMS_TOKEN_ENCRYPTION_SECRET must contain at least 32 characters',
      )
    }
    return configured
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('AIPMS_TOKEN_ENCRYPTION_SECRET is required in production')
  }
  return env.BETTER_AUTH_SECRET ?? 'aipms-dev-only-secret'
}

function previousSecret(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.AIPMS_TOKEN_ENCRYPTION_PREVIOUS_SECRET
  if (secret && secret.length < 32) {
    throw new Error(
      'AIPMS_TOKEN_ENCRYPTION_PREVIOUS_SECRET must contain at least 32 characters',
    )
  }
  return secret
}

function key(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

function keyId(secret: string) {
  return createHash('sha256')
    .update(`aipms-token-key:${secret}`)
    .digest('hex')
    .slice(0, 16)
}

function decryptWithKey(
  ivB64: string,
  tagB64: string,
  dataB64: string,
  secret: string,
) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(secret),
    Buffer.from(ivB64, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function encryptSecret(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = currentSecret(env)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v2',
    keyId(secret),
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join('.')
}

export function decryptSecret(
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts = payload.split('.')
  if (parts[0] === 'v2') {
    const [, payloadKeyId, ivB64, tagB64, dataB64] = parts
    if (!payloadKeyId || !ivB64 || !tagB64 || !dataB64 || parts.length !== 5) {
      throw new Error('Malformed encrypted payload')
    }
    const candidates = [currentSecret(env), previousSecret(env)].filter(
      (value): value is string => Boolean(value),
    )
    const selected = candidates.find((candidate) => {
      const left = Buffer.from(keyId(candidate))
      const right = Buffer.from(payloadKeyId)
      return left.length === right.length && timingSafeEqual(left, right)
    })
    if (!selected) {
      throw new Error('Encrypted payload key is not configured')
    }
    return decryptWithKey(ivB64, tagB64, dataB64, selected)
  }

  // v1 compatibility: iv.tag.ciphertext under BETTER_AUTH_SECRET.
  const [ivB64, tagB64, dataB64] = parts
  if (!ivB64 || !tagB64 || !dataB64 || parts.length !== 3) {
    throw new Error('Malformed encrypted payload')
  }
  const legacySecret = env.BETTER_AUTH_SECRET ?? 'aipms-dev-only-secret'
  return decryptWithKey(ivB64, tagB64, dataB64, legacySecret)
}

export function secretNeedsRotation(
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const [version, payloadKeyId] = payload.split('.')
  return version !== 'v2' || payloadKeyId !== keyId(currentSecret(env))
}
