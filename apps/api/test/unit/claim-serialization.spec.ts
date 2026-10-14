import './no-database'
import { ConflictException } from '@nestjs/common'
import type { Prisma, RequisitionStatus } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalService } from '../../src/approval/approval.service'
import { ErpService } from '../../src/erp/erp.service'
import { manifestHash, manifestToCsv } from '../../src/erp/journal'
import type { EventEmitterService } from '../../src/shared/events/event-emitter.service'

describe('Concurrency & Claim Serialization (Findings 8, 339, 340)', () => {
  describe('Sibling Approval Decision Serialization (Finding 8)', () => {
    interface ApprovalRecord {
      id: string
      requisitionId: string | null
      kind: string
      status: string
      route: string[]
      requestedBy: string
      decidedBy?: string | null
      decidedAt?: Date | null
      evidence?: string | null
    }

    interface RequisitionRecord {
      id: string
      status: RequisitionStatus
      decidedAt?: Date | null
    }

    function fixture() {
      const state = {
        requisition: {
          id: 'req-1',
          status: 'submitted' as RequisitionStatus,
          decidedAt: null as Date | null,
        } as RequisitionRecord,
        approvals: [
          {
            id: 'gate-1',
            requisitionId: 'req-1',
            kind: 'threshold',
            status: 'pending',
            route: ['finance'],
            requestedBy: 'requester-1',
          },
          {
            id: 'gate-2',
            requisitionId: 'req-1',
            kind: 'budgetOverride',
            status: 'pending',
            route: ['finance'],
            requestedBy: 'requester-1',
          },
        ] as ApprovalRecord[],
      }

      const timeline: string[] = []
      const events = {
        emit: vi.fn(async ({ type }: { type: string }) => {
          timeline.push(type)
        }),
      } as unknown as EventEmitterService

      const client = {
        $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
          const query = sql.join('?').replace(/\s+/g, ' ').trim()
          timeline.push(query)
          return []
        }),
        $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(client),
        ),
        user: {
          findUnique: vi.fn().mockResolvedValue({ role: 'finance' }),
        },
        approval: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            return state.approvals.find((a) => a.id === where.id) ?? null
          }),
          findUniqueOrThrow: vi.fn(
            async ({ where }: { where: { id: string } }) => {
              const a = state.approvals.find((row) => row.id === where.id)
              if (!a) throw new Error('Not found')
              return a
            },
          ),
          updateMany: vi.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string; status: string }
              data: Partial<ApprovalRecord>
            }) => {
              const a = state.approvals.find(
                (row) => row.id === where.id && row.status === where.status,
              )
              if (!a) return { count: 0 }
              Object.assign(a, data)
              return { count: 1 }
            },
          ),
          count: vi.fn(
            async ({
              where,
            }: {
              where: { requisitionId?: string; status?: string }
            }) => {
              return state.approvals.filter((a) => {
                if (
                  where.requisitionId &&
                  a.requisitionId !== where.requisitionId
                ) {
                  return false
                }
                if (where.status && a.status !== where.status) return false
                return true
              }).length
            },
          ),
        },
        requisition: {
          update: vi.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string }
              data: Partial<RequisitionRecord>
            }) => {
              if (where.id !== state.requisition.id)
                throw new Error('Not found')
              Object.assign(state.requisition, data)
              return state.requisition
            },
          ),
        },
      }

      const approvalService = new ApprovalService(events)

      return { state, client, approvalService, events, timeline }
    }

    it('locks the parent requisition with FOR UPDATE and aggregates multiple gates', async () => {
      const { client, approvalService, state, timeline, events } = fixture()

      // Decide gate 1 as approved
      const first = await approvalService.decide(
        'gate-1',
        'approve',
        'approver-1',
        'Valid first stage',
        client as unknown as Prisma.TransactionClient,
      )

      expect(first.outcome).toBe('APPROVED')
      expect(first.requisitionStatus).toBe('submitted')
      expect(state.requisition.status).toBe('submitted')

      // Verify row lock on requisition was acquired before decisions
      expect(
        timeline.some((entry) =>
          entry.includes(
            'SELECT id FROM "requisition" WHERE id = ? FOR UPDATE',
          ),
        ),
      ).toBe(true)

      // Decide gate 2 as approved
      const second = await approvalService.decide(
        'gate-2',
        'approve',
        'approver-2',
        'Valid second stage',
        client as unknown as Prisma.TransactionClient,
      )

      expect(second.outcome).toBe('APPROVED')
      expect(second.requisitionStatus).toBe('approved')
      expect(state.requisition.status).toBe('approved')

      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'requisition.approved',
          entityId: 'req-1',
        }),
        expect.anything(),
      )
    })

    it('immediately rejects requisition when any sibling gate is rejected', async () => {
      const { client, approvalService, state, events } = fixture()

      const rejected = await approvalService.decide(
        'gate-1',
        'reject',
        'approver-1',
        'Budget limit exceeded',
        client as unknown as Prisma.TransactionClient,
      )

      expect(rejected.outcome).toBe('REJECTED')
      expect(rejected.requisitionStatus).toBe('rejected')
      expect(state.requisition.status).toBe('rejected')

      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'requisition.rejected',
          entityId: 'req-1',
        }),
        expect.anything(),
      )
    })
  })

  describe('Frozen Export Idempotent Replay (Finding 339)', () => {
    function fixture() {
      const frozenManifest = {
        runNumber: 'PR-2026-0001',
        executedAt: new Date('2026-10-01T00:00:00Z').toISOString(),
        currencyCode: 'PHP',
        totalMinor: 100_000,
        entries: [
          {
            entryType: 'credit' as const,
            account: '2000-AP',
            vendorName: 'Acme Frozen Corp',
            amountMinor: 100_000,
            vatMinor: 12_000,
            ewtMinor: 1_000,
          },
        ],
      }
      const json = JSON.stringify(frozenManifest)
      const hash = manifestHash(json)

      const state = {
        export: {
          id: 'exp-1',
          runId: 'run-1',
          runNumber: 'PR-2026-0001',
          status: 'exported',
          manifestHash: hash,
          manifestJson: json,
          lineCount: 1,
          totalMinor: 100_000,
          currencyCode: 'PHP',
          exportedBy: 'finance-1',
          exportedAt: new Date(),
          dispatchClaimId: null as string | null,
          dispatchClaimedBy: null as string | null,
          dispatchFailure: null as string | null,
        },
        paymentRun: {
          id: 'run-1',
          runNumber: 'PR-2026-0001',
          status: 'executed',
          currencyCode: 'PHP',
          totalMinor: 100_000,
          executedAt: new Date('2026-10-01T00:00:00Z'),
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        },
      }

      const events = {
        emit: vi.fn().mockResolvedValue(undefined),
      } as unknown as EventEmitterService

      const client = {
        erpJournalExport: {
          findUnique: vi.fn(async ({ where }: { where: { runId: string } }) => {
            return where.runId === state.export.runId ? state.export : null
          }),
        },
        paymentRun: {
          findUniqueOrThrow: vi.fn(
            async ({ where }: { where: { id: string } }) => {
              if (where.id === state.paymentRun.id) return state.paymentRun
              throw new Error('Run not found')
            },
          ),
        },
      }

      const erpService = new ErpService(events)

      return { state, client, erpService, frozenManifest, json, hash }
    }

    it('returns frozen manifest on re-export without rebuilding from live vendor master', async () => {
      const { erpService, client, state, frozenManifest, json, hash } =
        fixture()

      // Spy on buildForRun to prove it is NOT called when frozen manifest exists
      const buildSpy = vi.spyOn(erpService as never, 'buildForRun')

      const res = await erpService.exportRun(
        'run-1',
        'finance-1',
        client as unknown as Prisma.TransactionClient,
      )

      expect(res.created).toBe(false)
      expect(res.export.id).toBe(state.export.id)
      expect(res.json).toBe(json)
      expect(res.hash).toBe(hash)
      expect(res.csv).toBe(manifestToCsv(frozenManifest))
      expect(buildSpy).not.toHaveBeenCalled()
    })
  })

  describe('QBO Dispatch Claim & Acknowledgement Race (Finding 340)', () => {
    function fixture(claimId: string | null = null) {
      const state = {
        export: {
          id: 'exp-1',
          runNumber: 'PR-2026-0001',
          status: 'exported',
          dispatchClaimId: claimId,
          dispatchClaimedBy: claimId ? 'qbo-agent' : null,
          dispatchFailure: null,
        },
      }

      const timeline: string[] = []
      const events = {
        emit: vi.fn(async ({ type }: { type: string }) => {
          timeline.push(type)
        }),
      } as unknown as EventEmitterService

      const client = {
        $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
          timeline.push(sql.join('?').replace(/\s+/g, ' ').trim())
          return 1
        }),
        $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
          timeline.push(sql.join('?').replace(/\s+/g, ' ').trim())
          return []
        }),
        erpJournalExport: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            return where.id === state.export.id ? state.export : null
          }),
          findUniqueOrThrow: vi.fn(
            async ({ where }: { where: { id: string } }) => {
              if (where.id === state.export.id) return state.export
              throw new Error('Not found')
            },
          ),
          updateMany: vi.fn(
            async ({
              where,
              data,
            }: {
              where: {
                id: string
                status: string
                dispatchClaimId?: string | null
              }
              data: Record<string, unknown>
            }) => {
              if (
                where.id === state.export.id &&
                where.status === state.export.status &&
                where.dispatchClaimId === state.export.dispatchClaimId
              ) {
                Object.assign(state.export, data)
                return { count: 1 }
              }
              return { count: 0 }
            },
          ),
        },
      }

      const erpService = new ErpService(events)

      return { state, client, erpService, timeline }
    }

    it('acquires advisory and row locks and acknowledges safely when no claim exists', async () => {
      const { client, erpService, state, timeline } = fixture(null)

      const res = await erpService.acknowledge(
        { exportId: 'exp-1', status: 'posted', externalRef: 'QBO-12345' },
        'finance-checker',
        client as unknown as Prisma.TransactionClient,
      )

      expect(res.status).toBe('posted')
      expect(state.export.status).toBe('posted')

      // Verifies both advisory lock on qbo-push and row lock on export were acquired
      expect(
        timeline.some((entry) =>
          entry.includes('SELECT pg_advisory_xact_lock(hashtext(?))'),
        ),
      ).toBe(true)
      expect(
        timeline.some((entry) =>
          entry.includes(
            'SELECT id FROM "erpJournalExport" WHERE id = ? FOR UPDATE',
          ),
        ),
      ).toBe(true)
    })

    it('rejects acknowledgement if a concurrent QBO dispatch claim intervened', async () => {
      const { client, erpService } = fixture(null)

      // Simulate a concurrent QBO push that slipped a claim after initial read
      client.erpJournalExport.updateMany = vi
        .fn()
        .mockResolvedValue({ count: 0 })

      await expect(
        erpService.acknowledge(
          { exportId: 'exp-1', status: 'posted', externalRef: 'QBO-12345' },
          'finance-checker',
          client as unknown as Prisma.TransactionClient,
        ),
      ).rejects.toThrow(ConflictException)
    })
  })
})
