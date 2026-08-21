import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Injectable } from '@nestjs/common'

/**
 * §16.3 qualified digital signatures — instance-level key material, no KMS
 * dependency (air-gapped friendly). Keys are ECDSA P-256 over SHA-256:
 *
 * - `AIPMS_SIGNING_KEYS_DIR` — directory of PEM private keys; the file name
 *   without extension is the key id (e.g. `/keys/purchasing-2026.pem`).
 * - `AIPMS_SIGNING_ACTIVE_KEY_ID` — which key signs new documents.
 * - `AIPMS_SIGNING_PUBLIC_KEYS_DIR` — optional; lets a verify-only node
 *   check signatures without holding private keys.
 *
 * Unconfigured instances simply have signing disabled — POs issue unsigned
 * and the sign endpoint explains what to configure (additive on shared core).
 */

export const SIGNATURE_ALGORITHM = 'ecdsa-p256-sha256' as const

export interface DetachedSignature {
  keyId: string
  algorithm: typeof SIGNATURE_ALGORITHM
  /** base64 DER-encoded ECDSA signature over the SHA-256 digest of payload. */
  signature: string
  /** SPKI PEM of the public key that verifies `signature`. */
  publicKeyPem: string
}

export class SigningNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SigningNotConfiguredError'
  }
}

@Injectable()
export class SigningService {
  private cache: {
    privateKeys: Map<string, KeyObject>
    publicKeys: Map<string, KeyObject>
    activeKeyId: string | null
  } | null = null

  isConfigured(): boolean {
    return this.load().activeKeyId !== null
  }

  activeKeyId(): string | null {
    return this.load().activeKeyId
  }

  /**
   * Signs an arbitrary payload (the canonical PO form). The detached
   * signature carries everything a third party needs to verify offline:
   * key id, algorithm, signature, and the public key itself.
   */
  sign(payload: string | Buffer): DetachedSignature {
    const store = this.load()
    if (!store.activeKeyId) {
      throw new SigningNotConfiguredError(
        'Signing is not configured — set AIPMS_SIGNING_KEYS_DIR and AIPMS_SIGNING_ACTIVE_KEY_ID',
      )
    }
    const privateKey = store.privateKeys.get(store.activeKeyId)
    if (!privateKey) {
      throw new SigningNotConfiguredError(
        `Active signing key "${store.activeKeyId}" is not present in AIPMS_SIGNING_KEYS_DIR`,
      )
    }
    const signature = createSign('sha256').update(payload).sign(privateKey)
    return {
      keyId: store.activeKeyId,
      algorithm: SIGNATURE_ALGORITHM,
      signature: signature.toString('base64'),
      publicKeyPem: createPublicKey(privateKey)
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    }
  }

  verify(
    payload: string | Buffer,
    sig: Pick<DetachedSignature, 'signature' | 'publicKeyPem'>,
  ): boolean {
    try {
      const publicKey = createPublicKey(sig.publicKeyPem)
      return createVerify('sha256')
        .update(payload)
        .verify(publicKey, Buffer.from(sig.signature, 'base64'))
    } catch {
      return false
    }
  }

  /**
   * Verify with an instance-mounted public key when the signer's embedded
   * key is unknown. Returns null when no key with that id is mounted.
   */
  verifyWithKey(
    payload: string | Buffer,
    keyId: string,
    signatureB64: string,
  ): boolean | null {
    const publicKey = this.load().publicKeys.get(keyId)
    if (!publicKey) return null
    try {
      return createVerify('sha256')
        .update(payload)
        .verify(publicKey, Buffer.from(signatureB64, 'base64'))
    } catch {
      return false
    }
  }

  /**
   * Canonical serialization: recursively sorted object keys, no whitespace —
   * byte-stable across processes so signatures verify years later.
   */
  canonicalize(value: unknown): string {
    return JSON.stringify(value, canonicalReplacer)
  }

  sha256(payload: string | Buffer): string {
    return createHash('sha256').update(payload).digest('hex')
  }

  /** Test helper — generate an EC P-256 pair as PEMs. */
  static generateKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    })
    return {
      privateKeyPem: privateKey
        .export({ type: 'sec1', format: 'pem' })
        .toString(),
      publicKeyPem: publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    }
  }

  private load() {
    if (this.cache) return this.cache

    const privateKeys = new Map<string, KeyObject>()
    const publicKeys = new Map<string, KeyObject>()

    const keysDir = process.env.AIPMS_SIGNING_KEYS_DIR
    if (keysDir && existsSync(keysDir)) {
      for (const entry of readdirSync(keysDir)) {
        if (!entry.endsWith('.pem')) continue
        const keyId = entry.replace(/\.pem$/, '')
        try {
          const pem = readFileSync(join(keysDir, entry), 'utf8')
          const key = createPrivateKey(pem)
          privateKeys.set(keyId, key)
          publicKeys.set(keyId, createPublicKey(key))
        } catch {
          // Not a private key PEM — try it as a plain public key.
          try {
            publicKeys.set(
              keyId,
              createPublicKey(readFileSync(join(keysDir, entry), 'utf8')),
            )
          } catch {
            // Unreadable key material is skipped; signing surfaces it later.
          }
        }
      }
    }

    const pubDir = process.env.AIPMS_SIGNING_PUBLIC_KEYS_DIR
    if (pubDir && existsSync(pubDir)) {
      for (const entry of readdirSync(pubDir)) {
        if (!entry.endsWith('.pem')) continue
        const keyId = entry.replace(/\.pem$/, '')
        if (publicKeys.has(keyId)) continue
        try {
          publicKeys.set(
            keyId,
            createPublicKey(readFileSync(join(pubDir, entry), 'utf8')),
          )
        } catch {
          // Skip unreadable material.
        }
      }
    }

    const activeKeyId = process.env.AIPMS_SIGNING_ACTIVE_KEY_ID ?? null
    this.cache = { privateKeys, publicKeys, activeKeyId }
    return this.cache
  }
}

/** Stable JSON: sorted keys, undefined dropped, bigints stringified. */
function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) sorted[k] = v
    }
    return sorted
  }
  return value
}
