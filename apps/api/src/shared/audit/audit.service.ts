import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { db, Prisma, type UserKind } from '@workspace/db'
import { paginate } from '../../trpc/list-input'

/**
 * §9 append-only audit trail. Every agent/human state change records an
 * AuditEntry: who (principal), what (action + entity), the content-addressed
 * input, and the before/after snapshots. No update/delete path is exposed for
 * AuditEntry — the table is append-only by construction.
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

  async record(input: AuditRecordInput): Promise<void> {
    await db.auditEntry.create({
      data: {
        actorId: input.actorId,
        actorKind: input.actorKind,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        inputHash: this.hash(input.input),
        ...(input.before !== undefined && input.before !== null
          ? { before: input.before as object }
          : {}),
        ...(input.after !== undefined && input.after !== null
          ? { after: input.after as object }
          : {}),
      },
    })
  }

  /**
   * §16 review — paginated, newest-first read of the immutable trail. Read
   * filters are a narrow, additive surface; there is intentionally no
   * update/delete path for AuditEntry.
   */
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
