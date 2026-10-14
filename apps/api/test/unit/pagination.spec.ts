import './no-database'
import { describe, expect, it, vi } from 'vitest'
import { PaymentRunRouter } from '../../src/payment-run/payment-run.router'
import type { PaymentRunService } from '../../src/payment-run/payment-run.service'
import type { AuditService } from '../../src/shared/audit/audit.service'
import type { IdempotencyService } from '../../src/shared/idempotency/idempotency.service'
import { AGENT_CAPABILITIES } from '../../src/trpc/agent-capabilities'
import { HUMAN_PROCEDURE_ROLES } from '../../src/trpc/authorize'

describe('keyset and stable pagination policies', () => {
  it('enforces RBAC role grants for intake.page and paymentRun.page', () => {
    expect(HUMAN_PROCEDURE_ROLES['intake.page']).toEqual(['finance'])
    expect(HUMAN_PROCEDURE_ROLES['paymentRun.page']).toEqual(['finance'])
  })

  it('allows agents to read intake.page with intake.read scope', () => {
    expect(AGENT_CAPABILITIES['intake.page']).toBe('intake.read')
  })

  it('keeps paymentRun.page strictly ungrantable for agents (default-deny)', () => {
    expect(AGENT_CAPABILITIES['paymentRun.page']).toBeUndefined()
  })

  it('routes PaymentRunRouter.page directly to PaymentRunService.page', async () => {
    const fakeRows = [
      {
        id: 'run-1',
        runNumber: 'PR-2026-0001',
        status: 'draft',
        totalMinor: 150000,
        currencyCode: 'PHP',
        notes: null,
        createdBy: 'user-1',
        approvedBy: null,
        approvedAt: null,
        executedBy: null,
        executedAt: null,
        voidedBy: null,
        voidedAt: null,
        voidReason: null,
        reconciledAt: null,
        createdAt: new Date('2026-08-01T10:00:00Z'),
        updatedAt: new Date('2026-08-01T10:00:00Z'),
        lines: [],
      },
    ]
    const runsService = {
      list: vi.fn(),
      page: vi.fn().mockResolvedValue({ rows: fakeRows, total: 1 }),
      detail: vi.fn(),
    }
    const idempotency = {} as IdempotencyService
    const audit = {} as AuditService

    const router = new PaymentRunRouter(
      runsService as unknown as PaymentRunService,
      idempotency,
      audit,
    )

    const input = {
      q: 'PR-2026',
      sort: '',
      dir: 'asc' as const,
      page: 1,
      pageSize: 25,
      status: 'draft' as const,
    }

    const result = await router.page(input)
    expect(result).toEqual({ rows: fakeRows, total: 1 })
    expect(runsService.page).toHaveBeenCalledWith(input)
  })
})
