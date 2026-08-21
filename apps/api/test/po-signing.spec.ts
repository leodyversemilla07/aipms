import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PoSigningService } from '../src/purchase-order/po-signing.service'
import {
  SIGNATURE_ALGORITHM,
  SigningService,
} from '../src/shared/signing/signing.service'
import type { AuthedTrpcContext } from '../src/trpc/context.types'

/**
 * §16.3/§16.4 — qualified PO signatures: detached ECDSA over a canonical
 * snapshot, human-only countersigning (agents never sign), tamper detection
 * against the PO's current state.
 */

let keysDir: string
let activeKeyId: string

function ctx(partial: {
  id?: string
  kind?: 'human' | 'agent'
  role?: 'admin' | 'procurement' | 'finance' | 'user'
}): AuthedTrpcContext {
  const id = partial.id ?? 'signer-1'
  return {
    req: undefined,
    session: null,
    user: {
      id,
      name: 'Signer',
      email: `${id}@test.local`,
      emailVerified: true,
      image: null,
      kind: partial.kind ?? 'human',
      role: partial.role ?? 'procurement',
    },
    actorKind: partial.kind ?? 'human',
  }
}

async function seedIssuedPo(): Promise<{ poId: string; vendorId: string }> {
  const vendor = await db.vendor.create({
    data: { id: `ven-${randomUUID()}`, name: 'Sig Vendor', status: 'active' },
  })
  const po = await db.purchaseOrder.create({
    data: {
      poNumber: `PO-SIG-${randomUUID().slice(0, 8)}`,
      vendorId: vendor.id,
      status: 'issued',
      totalMinor: 2500,
      issuedBy: 'seed',
      issuedAt: new Date('2026-01-15T08:00:00Z'),
      terms: { paymentDays: 30 },
      lines: {
        create: [
          {
            lineNo: 1,
            description: 'Widget',
            quantity: 2,
            unitPriceMinor: 1000,
            lineTotalMinor: 2000,
          },
          {
            lineNo: 2,
            sku: 'SVC-1',
            description: 'Service',
            quantity: 1,
            unitPriceMinor: 500,
            lineTotalMinor: 500,
          },
        ],
      },
    },
  })
  return { poId: po.id, vendorId: vendor.id }
}

describe('Qualified PO signing', () => {
  let signing: SigningService
  let service: PoSigningService

  beforeAll(() => {
    const { privateKeyPem } = SigningService.generateKeyPair()
    keysDir = mkdtempSync(join(tmpdir(), 'aipms-signing-'))
    activeKeyId = 'test-key-2026'
    writeFileSync(join(keysDir, `${activeKeyId}.pem`), privateKeyPem)
    process.env.AIPMS_SIGNING_KEYS_DIR = keysDir
    process.env.AIPMS_SIGNING_ACTIVE_KEY_ID = activeKeyId
    signing = new SigningService()
    service = new PoSigningService(signing)
  })

  afterAll(async () => {
    rmSync(keysDir, { recursive: true, force: true })
    delete process.env.AIPMS_SIGNING_KEYS_DIR
    delete process.env.AIPMS_SIGNING_ACTIVE_KEY_ID
    await db.poSignature.deleteMany({})
    await db.purchaseOrderLine.deleteMany({})
    await db.purchaseOrder.deleteMany({})
    await db.vendor.deleteMany({ where: { name: 'Sig Vendor' } })
    await db.$disconnect()
  })

  beforeEach(async () => {
    await db.poSignature.deleteMany({})
  })

  it('produces a byte-stable canonical form', () => {
    const a = signing.canonicalize({ b: 2, a: { d: [1, { c: 3, a: 1 }] } })
    const b = signing.canonicalize({ a: { d: [1, { a: 1, c: 3 }] }, b: 2 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"d":[1,{"a":1,"c":3}]},"b":2}')
  })

  it('signs and verifies an unchanged PO', async () => {
    const { poId } = await seedIssuedPo()

    const signed = await service.sign(poId, ctx({ role: 'procurement' }))
    expect(signed.signed).toBe(true)
    expect(signed.keyId).toBe(activeKeyId)
    expect(signed.algorithm).toBe(SIGNATURE_ALGORITHM)

    const result = await service.verify(poId)
    expect(result.signed).toBe(true)
    expect(result.signatureValid).toBe(true)
    expect(result.documentUnchanged).toBe(true)
  })

  it('detects post-signing tampering', async () => {
    const { poId } = await seedIssuedPo()
    await service.sign(poId, ctx({}))

    // Mutate the document after signing.
    await db.purchaseOrder.update({
      where: { id: poId },
      data: { totalMinor: 999_999 },
    })

    const result = await service.verify(poId)
    expect(result.signed).toBe(true)
    expect(result.documentUnchanged).toBe(false)
  })

  it('rejects agent principals — agents never countersign', async () => {
    expect(() =>
      PoSigningService.assertHumanSigner(ctx({ kind: 'agent', role: 'admin' })),
    ).toThrow(/never sign/)
  })

  it('enforces the human role gate', () => {
    expect(() =>
      PoSigningService.assertHumanSigner(ctx({ role: 'user' })),
    ).toThrow(/requires role/)
    for (const role of ['admin', 'procurement', 'finance'] as const) {
      expect(() =>
        PoSigningService.assertHumanSigner(ctx({ role })),
      ).not.toThrow()
    }
  })

  it('refuses to sign when no key material is configured', async () => {
    delete process.env.AIPMS_SIGNING_ACTIVE_KEY_ID
    try {
      const fresh = new SigningService()
      const freshService = new PoSigningService(fresh)
      const { poId } = await seedIssuedPo()
      await expect(freshService.sign(poId, ctx({}))).rejects.toThrow(
        /Signing is not configured/,
      )
    } finally {
      process.env.AIPMS_SIGNING_ACTIVE_KEY_ID = activeKeyId
    }
  })

  it('reports unsigned POs', async () => {
    const { poId } = await seedIssuedPo()
    const result = await service.verify(poId)
    expect(result.signed).toBe(false)
  })
})
