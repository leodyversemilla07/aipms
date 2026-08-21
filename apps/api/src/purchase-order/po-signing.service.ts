import { Injectable } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import { db, type UserRole } from '@workspace/db'
import {
  type DetachedSignature,
  SIGNATURE_ALGORITHM,
  SigningNotConfiguredError,
  SigningService,
} from '../shared/signing/signing.service'
import type { AuthedTrpcContext } from '../trpc/context.types'

/**
 * §16.4 — "agents prepare documents but never countersign; POs carry
 * qualified electronic signature gates (human + certificate)". The signature
 * is detached, over the canonical PO snapshot at signing time; verification
 * recomputes the snapshot from current state so any post-signing drift is
 * detectable even before the cryptographic check.
 */

/** Roles allowed to countersign a PO with the instance certificate. */
const SIGNING_ROLES: UserRole[] = ['admin', 'procurement', 'finance']

export interface PoSignatureView {
  signed: boolean
  configured: boolean
  keyId?: string
  algorithm?: string
  signerId?: string
  signedAt?: string
  /** Cryptographic check: the signature matches its claimed public key. */
  signatureValid?: boolean
  /** Integrity check: the PO's current state equals the signed snapshot. */
  documentUnchanged?: boolean
}

@Injectable()
export class PoSigningService {
  constructor(private readonly signing: SigningService) {}

  /**
   * §16.4 SoD — signing is a human act with the instance certificate; agent
   * principals are scope-governed and must never countersign.
   */
  static assertHumanSigner(ctx: AuthedTrpcContext): void {
    if (ctx.actorKind !== 'human') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Only humans may countersign — agents prepare documents but never sign',
      })
    }
    const role = ctx.user.role ?? 'user'
    if (!SIGNING_ROLES.includes(role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `PO signing requires role: ${SIGNING_ROLES.join(' or ')}`,
      })
    }
  }

  async sign(poId: string, ctx: AuthedTrpcContext): Promise<PoSignatureView> {
    const po = await this.load(poId)
    if (po.status !== 'issued' && po.status !== 'confirmed') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Only an issued or confirmed PO can be signed',
      })
    }

    const canonical = this.signing.canonicalize(this.canonicalPo(po))
    let sig: DetachedSignature
    try {
      sig = this.signing.sign(canonical)
    } catch (error) {
      if (error instanceof SigningNotConfiguredError) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: error.message,
        })
      }
      throw error
    }

    const created = await db.poSignature.create({
      data: {
        poId: po.id,
        keyId: sig.keyId,
        algorithm: sig.algorithm,
        payloadHash: this.signing.sha256(canonical),
        signature: sig.signature,
        publicKeyPem: sig.publicKeyPem,
        signerId: ctx.user.id,
      },
    })

    return {
      signed: true,
      configured: true,
      keyId: created.keyId,
      algorithm: created.algorithm,
      signerId: created.signerId,
      signedAt: created.signedAt.toISOString(),
      signatureValid: true,
      documentUnchanged: true,
    }
  }

  /**
   * Verify the latest signature against the PO's CURRENT state:
   * `documentUnchanged` compares the canonical hash; `signatureValid` is the
   * ECDSA check against the embedded public key (with the instance-mounted
   * key as fallback when the signing key came from elsewhere).
   */
  async verify(poId: string): Promise<PoSignatureView> {
    const [po, latest] = await Promise.all([
      this.load(poId),
      db.poSignature.findFirst({
        where: { poId },
        orderBy: { signedAt: 'desc' },
      }),
    ])
    if (!latest) {
      return { signed: false, configured: this.signing.isConfigured() }
    }

    const canonical = this.signing.canonicalize(this.canonicalPo(po))
    const currentHash = this.signing.sha256(canonical)
    const documentUnchanged = currentHash === latest.payloadHash

    let signatureValid = this.signing.verify(canonical, {
      signature: latest.signature,
      publicKeyPem: latest.publicKeyPem,
    })
    if (!signatureValid) {
      const mounted = this.signing.verifyWithKey(
        canonical,
        latest.keyId,
        latest.signature,
      )
      if (mounted !== null) signatureValid = mounted
    }

    return {
      signed: true,
      configured: this.signing.isConfigured(),
      keyId: latest.keyId,
      algorithm: latest.algorithm,
      signerId: latest.signerId,
      signedAt: latest.signedAt.toISOString(),
      signatureValid,
      documentUnchanged,
    }
  }

  status(): { configured: boolean; activeKeyId: string | null } {
    return {
      configured: this.signing.isConfigured(),
      activeKeyId: this.signing.activeKeyId(),
    }
  }

  private load(poId: string) {
    return db.purchaseOrder
      .findUnique({ where: { id: poId }, include: { lines: true } })
      .then((po) => {
        if (!po) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `PurchaseOrder ${poId} not found`,
          })
        }
        return po
      })
  }

  /** Byte-stable snapshot of exactly what the signer attested. */
  private canonicalPo(po: {
    poNumber: string
    requisitionId: string | null
    vendorId: string
    status: string
    currencyCode: string
    totalMinor: number
    terms: unknown
    issuedBy: string
    issuedAt: Date | null
    lines: Array<{
      lineNo: number
      sku: string | null
      description: string
      quantity: number
      unit: string
      unitPriceMinor: number
      currencyCode: string
      lineTotalMinor: number
    }>
  }) {
    return {
      algorithm: SIGNATURE_ALGORITHM,
      document: 'purchase-order',
      poNumber: po.poNumber,
      requisitionId: po.requisitionId,
      vendorId: po.vendorId,
      status: po.status,
      currencyCode: po.currencyCode,
      totalMinor: po.totalMinor,
      terms: po.terms ?? null,
      issuedBy: po.issuedBy,
      issuedAt: po.issuedAt ? po.issuedAt.toISOString() : null,
      lines: [...po.lines]
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((l) => ({
          lineNo: l.lineNo,
          sku: l.sku,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unitPriceMinor: l.unitPriceMinor,
          currencyCode: l.currencyCode,
          lineTotalMinor: l.lineTotalMinor,
        })),
    }
  }
}
