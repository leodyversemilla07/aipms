import { createHash, randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { db, isSqlite, Prisma, type UserKind } from '@workspace/db'
import { paginate } from '../../trpc/list-input'
import { lockScope } from '../locks'

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
  runId?: string | null
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
  /** How the trail compares to a checkpoint retained outside the database. */
  checkpoint?: CheckpointComparison
}

/**
 * The chain head, for an operator to retain *outside* the database.
 *
 * A checkpoint only proves something when its holder keeps it somewhere the
 * trail's writer cannot reach: the same database can rewrite both the trail
 * and a checkpoint stored beside it.
 */
export interface ChainCheckpoint {
  /** Sequence number of the checkpointed entry. */
  seq: number
  /** Hash the checkpointed entry committed to. */
  entryHash: string
  /** When the checkpointed entry was recorded (ISO 8601). */
  at: string
  /** Entries in the trail when the checkpoint was taken. */
  total: number
}

/**
 * How the trail compares to a retained checkpoint.
 *
 * - `advanced`  the trail grew past the checkpoint and the checkpointed entry
 *   is intact — the expected outcome.
 * - `truncated` the trail now ends before the checkpoint: the tip was removed.
 * - `rewritten` the checkpointed entry still exists but no longer matches the
 *   hash the checkpoint retained: the history was rewritten in place.
 * - `missing`   nothing remains at the checkpointed sequence: entries were
 *   deleted from the middle of the trail.
 */
export type CheckpointStatus =
  | 'advanced'
  | 'truncated'
  | 'rewritten'
  | 'missing'

export interface CheckpointComparison {
  status: CheckpointStatus
  expectedSeq: number
  expectedHash: string
  currentSeq: number | null
  currentHash: string | null
  /** Operator-facing explanation of the verdict. */
  detail: string
}

/** The row fields an entry's hash commits to. */
const VERIFICATION_PAGE_SIZE = 500

interface ChainContent {
  runId?: string
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
      // or concurrent writers would fork the chain. SQLite serialises writers
      // for the whole transaction, so the advisory lock is a no-op there.
      if (!isSqlite()) {
        await lockScope(tx, 'aipms-audit-chain')
      }

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
        ...(input.runId ? { runId: input.runId } : {}),
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

      // PostgreSQL assigns the chain sequence from a column default. SQLite
      // can only auto-increment a primary key, so the writer takes the next
      // sequence itself - safe under SQLite's exclusive write transaction.
      const seq = isSqlite() ? await this.nextSeq(tx) : undefined

      await tx.auditEntry.create({
        data: {
          id,
          runId: input.runId ?? null,
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
          ...(seq === undefined ? {} : { seq }),
        },
      })
    }
    if (transaction) await append(transaction)
    else await db.$transaction(append)
  }

  /** The next chain sequence, across legacy and chained rows alike. */
  private async nextSeq(tx: Prisma.TransactionClient): Promise<number> {
    const highest = await tx.auditEntry.aggregate({ _max: { seq: true } })
    return (highest._max.seq ?? 0) + 1
  }

  /**
   * §16.3 — the current chain head, for an operator to retain outside the
   * database. Reading it is cheap; retaining it is the operator's job.
   */
  async checkpoint(
    client: Prisma.TransactionClient | typeof db = db,
  ): Promise<ChainCheckpoint | null> {
    // The chain tip is the newest *hashed* entry: legacy rows predate the
    // chain and are not linked into it.
    const head = await client.auditEntry.findFirst({
      where: { entryHash: { not: null } },
      orderBy: { seq: 'desc' },
      select: { seq: true, entryHash: true, at: true },
    })
    if (!head || head.entryHash === null) return null
    const total = await client.auditEntry.count({
      where: { entryHash: { not: null } },
    })
    return {
      seq: head.seq,
      entryHash: head.entryHash,
      at: head.at.toISOString(),
      total,
    }
  }

  /**
   * §16.3 — compare the trail against a checkpoint the operator retained
   * outside the database. Internal consistency cannot see a removed tip, so
   * the retained head is the only evidence that the trail still ends where
   * it did.
   */
  private async compareCheckpoint(
    client: Prisma.TransactionClient | typeof db,
    expected: { seq: number; entryHash: string },
  ): Promise<CheckpointComparison> {
    const head = await client.auditEntry.findFirst({
      where: { entryHash: { not: null } },
      orderBy: { seq: 'desc' },
      select: { seq: true, entryHash: true },
    })
    const base = {
      expectedSeq: expected.seq,
      expectedHash: expected.entryHash,
      currentSeq: head?.seq ?? null,
      currentHash: head?.entryHash ?? null,
    }

    if (!head) {
      return {
        ...base,
        status: 'truncated',
        detail:
          'the trail is empty: every entry since the checkpoint was retained is gone',
      }
    }

    if (head.seq < expected.seq) {
      return {
        ...base,
        status: 'truncated',
        detail: `the trail now ends at seq ${head.seq}, behind the retained checkpoint at seq ${expected.seq}`,
      }
    }

    const at = await client.auditEntry.findFirst({
      where: { seq: expected.seq },
      select: { seq: true, entryHash: true },
    })

    if (!at) {
      return {
        ...base,
        status: 'missing',
        detail: `no entry remains at seq ${expected.seq}: the trail has a hole where the checkpoint was taken`,
      }
    }

    if (at.entryHash !== expected.entryHash) {
      return {
        ...base,
        status: 'rewritten',
        detail: `the entry at seq ${expected.seq} no longer matches the hash the checkpoint retained`,
      }
    }

    return {
      ...base,
      status: 'advanced',
      detail:
        head.seq === expected.seq
          ? `the trail still ends at seq ${head.seq} with the checkpointed entry intact`
          : `the trail advanced from seq ${expected.seq} to seq ${head.seq} with the checkpointed entry intact`,
    }
  }

  /**
   * §16.3 — walk the chain in insertion order and recompute every hash.
   * Changed content or predecessor links break verification. Detecting tail
   * truncation additionally requires an independently retained checkpoint.
   *
   * The walk is pinned to the head sequence captured before the first page:
   * entries appended during verification belong to the next verification,
   * so the scan cannot be extended indefinitely by concurrent writers.
   */
  async verifyChain(
    client: Prisma.TransactionClient | typeof db = db,
    expected?: { seq: number; entryHash: string },
  ): Promise<ChainVerification> {
    // Compared before the walk so a retained checkpoint is reported even when
    // the walk itself is still in progress.
    const checkpoint = expected
      ? await this.compareCheckpoint(client, expected)
      : undefined
    const head = await client.auditEntry.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    const highWater = head?.seq

    // Count separately so failures retain the total legacy count, even when
    // verification stops early. Keyset pagination keeps memory bounded and
    // avoids increasingly expensive OFFSET scans as the trail grows.
    const legacy = await client.auditEntry.count({
      where: { entryHash: null },
    })
    let checked = 0
    let expectedPrev: string | null = null
    let lastSeq: number | undefined

    while (true) {
      const entries = await client.auditEntry.findMany({
        where: { seq: { gt: lastSeq, lte: highWater } },
        orderBy: { seq: 'asc' },
        take: VERIFICATION_PAGE_SIZE,
        select: {
          seq: true,
          id: true,
          runId: true,
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
            checkpoint,
          }
        }

        const recomputed = this.entryHash(e.prevHash, e.id, e.at, {
          ...(e.runId ? { runId: e.runId } : {}),
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
            checkpoint,
          }
        }
        expectedPrev = e.entryHash
      }
      const lastEntry = entries.at(-1)
      if (entries.length < VERIFICATION_PAGE_SIZE || !lastEntry) break
      lastSeq = lastEntry.seq
    }

    // The trail is internally consistent. It can still have lost its tip, so a
    // retained checkpoint has the final say.
    if (checkpoint && checkpoint.status !== 'advanced') {
      return {
        ok: false,
        checked,
        legacy,
        reason: checkpoint.detail,
        checkpoint,
      }
    }

    return { ok: true, checked, legacy, checkpoint }
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
        orderBy: [{ at: 'desc' }, { seq: 'desc' }],
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
