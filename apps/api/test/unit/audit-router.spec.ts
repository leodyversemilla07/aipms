import './no-database'
import { describe, expect, it, vi } from 'vitest'
import { AuditRouter } from '../../src/audit/audit.router'
import type { AuditService } from '../../src/shared/audit/audit.service'
import type { AuthedTrpcContext } from '../../src/trpc/context.types'

const input = { q: '', sort: '', dir: 'asc' as const, page: 2, pageSize: 25 }
const row = {
  id: 'audit-1',
  seq: 7,
  runId: 'run-1',
  actorId: 'agent-1',
  actorKind: 'agent',
  action: 'intake.classify',
  entity: 'IntakeDocument',
  entityId: 'intake-1',
  inputHash: 'input-hash',
  prevHash: 'previous-hash',
  entryHash: 'entry-hash',
  at: new Date('2026-08-01T12:00:00Z'),
  before: { bankAccount: 'sensitive-before-account' },
  after: {
    raw: { contentBase64: 'sensitive-binary-body' },
    classified: { apiToken: 'sensitive-token' },
  },
}

function fixture() {
  const result = { rows: [structuredClone(row)], total: 75, facetCounts: {} }
  const audit = { list: vi.fn().mockResolvedValue(result) }
  const router = new AuditRouter(audit as unknown as AuditService)
  return { result, audit, router }
}

function context(actorKind: 'human' | 'agent') {
  return { actorKind } as AuthedTrpcContext
}

describe('agent audit responses cannot bypass payload boundaries', () => {
  it('withholds every snapshot while preserving metadata, hashes, and pagination', async () => {
    const { result, audit, router } = fixture()
    const original = structuredClone(result)
    result.rows.push({
      ...structuredClone(row),
      id: 'audit-2',
      entity: 'PaymentRun',
    })
    const response = await router.list(input, context('agent'))
    expect(response.total).toBe(75)
    expect(response.rows).toHaveLength(2)
    for (const [index, projected] of response.rows.entries()) {
      expect(projected).toEqual({
        ...result.rows[index],
        before: null,
        after: null,
      })
    }
    expect(JSON.stringify(response)).not.toContain('sensitive-')
    expect(result.rows[0]).toEqual(original.rows[0])
    expect(result.rows[1].after).toEqual(row.after)
    expect(audit.list).toHaveBeenCalledWith(input)
  })

  it('keeps full evidence available to authorized humans without modifying it', async () => {
    const { result, router } = fixture()
    expect(await router.list(input, context('human'))).toBe(result)
  })

  it('preserves empty-page pagination for agents', async () => {
    const { audit, router } = fixture()
    audit.list.mockResolvedValue({ rows: [], total: 75, facetCounts: {} })
    expect(await router.list(input, context('agent'))).toEqual({
      rows: [],
      total: 75,
      facetCounts: {},
    })
  })
})
