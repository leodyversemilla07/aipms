import { createHash } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { db, type UserKind } from '@workspace/db'

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
