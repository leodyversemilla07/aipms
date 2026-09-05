import { createHash, randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { db, Prisma, type UserKind } from '@workspace/db'
import { paginate } from '../../trpc/list-input'

/**
 * §9 append-only audit trail. Every agent/human state change records an
 * AuditEntry: who (principal), what (action + entity), the content-addressed
 * input, and the before/after snapshots. No update/delete path is exposed for
 * AuditEntry — the table is append-only by construction.
 *
 * §16.3 tamper-evident chain: each entry commits to the previous entry's
 * hash (`prevHash` → `entryHash`) over exactly the fields stored on the row.
 * Inserts serialize on a Postgres advisory lock so concurrent writers cannot
 * fork the chain. Rows recorded before the feature shipped have null hashes
 * ("legacy") and are skipped by verification.
 */
export interface AuditRecordInput {
  actorId: string
  actorKind: UserKind
  action: string
  entity: string
  entityId?: string | null
  input?: object | null
  before?: object | null
  after?: object | null
}

export interface ChainVerification {
  ok: boolean
  /** Chained entries checked (legacy rows excluded). */
  checked: number
  /** Rows predating the chain (null hashes) — skipped. */
  legacy: number
  /** seq of the first entry where verification failed. */
  brokenAtSeq?: number
  reason?: string
}

/** The row fields an entry's hash commits to. */
interface ChainContent {
  actorId: string
  actorKind: string
  action: string
  entity: string
  entityId: string | null
  inputHash: string | null
  before: unknown
  after: unknown
}

@Injectable()
export class AuditService {
  /**
   * Content-address: a stable hash of a serialized value. Used as `inputHash`
   * so a record is tamper-evident without storing a full duplicate payload.
   */
  hash(value: unknown): string | null {
    if (value === undefined || value === null) return null
    const stable = JSON.stringify(value, jsonReplacer)
    return createHash('sha256').update(stable).digest('hex')
  }

  async record(
    input: AuditRecordInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const append = async (tx: Prisma.TransactionClient) => {
      // Serialize chain appends: read-then-insert of prevHash must be linear
      // or concurrent writers would fork the chain.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aipms-audit-chain'))`

      const prev = await tx.auditEntry.findFirst({
        where: { entryHash: { not: null } },
        orderBy: { seq: 'desc' },
        select: { entryHash: true },
      })
      const prevHash = prev?.entryHash ?? null

      const id = randomUUID()
      const at = new Date()
      const inputHash = this.hash(input.input)
      const content: ChainContent = {
        actorId: input.actorId,
        actorKind: input.actorKind,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        inputHash,
        before: input.before ?? null,
        after: input.after ?? null,
      }
      const entryHash = this.entryHash(prevHash, id, at, content)

      await tx.auditEntry.create({
        data: {
          id,
          actorId: input.actorId,
          actorKind: input.actorKind,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId ?? null,
          inputHash,
          ...(input.before !== undefined && input.before !== null
            ? { before: input.before as object }
            : {}),
          ...(input.after !== undefined && input.after !== null
            ? { after: input.after as object }
            : {}),
          at,
          prevHash,
          entryHash,
        },
      })
    }
    if (transaction) await append(transaction)
    else await db.$transaction(append)
  }

  /**
   * §16.3 — walk the chain in insertion order and recompute every hash. Any
   * edit, deletion, or reordering of chained rows breaks verification here.
   */
  async verifyChain(): Promise<ChainVerification> {
    const entries = await db.auditEntry.findMany({
      orderBy: { seq: 'asc' },
      select: {
        seq: true,
        id: true,
        actorId: true,
        actorKind: true,
        action: true,
        entity: true,
        entityId: true,
        inputHash: true,
        before: true,
        after: true,
        at: true,
        prevHash: true,
        entryHash: true,
      },
    })

    const legacy = entries.filter((e) => e.entryHash === null).length
    let checked = 0
    let expectedPrev: string | null = null

    for (const e of entries) {
      if (e.entryHash === null) continue // legacy row
      checked++

      if (e.prevHash !== expectedPrev) {
        return {
          ok: false,
          checked,
          legacy,
          brokenAtSeq: e.seq,
          reason:
            expectedPrev === null
              ? 'first chained entry carries an unexpected prevHash'
              : 'prevHash does not match the preceding chained entry',
        }
      }

      const recomputed = this.entryHash(e.prevHash, e.id, e.at, {
        actorId: e.actorId,
        actorKind: e.actorKind,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        inputHash: e.inputHash,
        before: e.before ?? null,
        after: e.after ?? null,
      })
      if (recomputed !== e.entryHash) {
        return {
          ok: false,
          checked,
          legacy,
          brokenAtSeq: e.seq,
          reason: 'entry content no longer matches its committed hash',
        }
      }
      expectedPrev = e.entryHash
    }

    return { ok: true, checked, legacy }
  }

  /** Review — paginated, newest-first read of the immutable trail. Read
   * filters are a narrow, additive surface; there is intentionally no
   * update/delete path for AuditEntry. */
  async list(input: {
    q?: string
    entity?: string
    action?: string
    page: number
    pageSize: number
  }) {
    const { skip, take } = paginate(input)
    const where: Prisma.AuditEntryWhereInput = {}
    if (input.entity) where.entity = input.entity
    if (input.action) where.action = input.action
    if (input.q) {
      where.OR = [
        { action: { contains: input.q, mode: 'insensitive' } },
        { entity: { contains: input.q, mode: 'insensitive' } },
        { entityId: { contains: input.q, mode: 'insensitive' } },
        { actorId: { contains: input.q, mode: 'insensitive' } },
      ]
    }
    const [rows, total] = await Promise.all([
      db.auditEntry.findMany({
        where,
        skip,
        take,
        orderBy: { at: 'desc' },
      }),
      db.auditEntry.count({ where }),
    ])
    return { rows, total, facetCounts: {} }
  }

  /** Distinct entities / actions for the audit viewer's filter dropdowns. */
  async meta() {
    const [entities, actions] = await Promise.all([
      db.auditEntry.groupBy({
        by: ['entity'],
        _count: { _all: true },
        orderBy: { _count: { entity: 'desc' } },
      }),
      db.auditEntry.groupBy({
        by: ['action'],
        _count: { _all: true },
        orderBy: { _count: { action: 'desc' } },
      }),
    ])
    return {
      entities: entities.map((e) => e.entity),
      actions: actions.map((a) => a.action),
    }
  }

  private entryHash(
    prevHash: string | null,
    id: string,
    at: Date,
    content: ChainContent,
  ): string {
    const stable = JSON.stringify(content, jsonReplacer)
    return createHash('sha256')
      .update(`${prevHash ?? ''}\n${id}\n${at.toISOString()}\n${stable}`)
      .digest('hex')
  }
}

/** Canonicalize objects (stable key order, drop undefined) for hashing. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) return null
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const next = (value as Record<string, unknown>)[key]
      if (next !== undefined) sorted[key] = next
    }
    return sorted
  }
  return value
}
