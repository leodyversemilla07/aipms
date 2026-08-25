import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { AnalyticsService } from '../src/analytics/analytics.service'

/**
 * §14 observability — aggregations over seeded domain rows. Everything
 * derives at query time; these tests pin the shapes and the math.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const cleanup: { approvals: string[]; runs: string[]; budgets: string[] } = {
  approvals: [],
  runs: [],
  budgets: [],
}

afterAll(async () => {
  await db.approval.deleteMany({ where: { id: { in: cleanup.approvals } } })
  await db.agentRun.deleteMany({ where: { id: { in: cleanup.runs } } })
  await db.budget.deleteMany({ where: { id: { in: cleanup.budgets } } })
  await db.$disconnect()
})

describe('AnalyticsService (§14)', () => {
  const svc = new AnalyticsService()

  it('aggregates gate decisions and decision SLA', async () => {
    const now = Date.now()
    const rows = [
      // decided fast (5 min)
      {
        kind: 'threshold' as const,
        status: 'approved' as const,
        gateOutcome: 'NEED_APPROVAL',
        route: [],
        createdAt: new Date(now - 10 * 60_000),
        decidedAt: new Date(now - 5 * 60_000),
        decidedBy: 'u1',
      },
      // decided slowly (100 min)
      {
        kind: 'budgetOverride' as const,
        status: 'rejected' as const,
        gateOutcome: 'NEED_APPROVAL',
        route: [],
        createdAt: new Date(now - 200 * 60_000),
        decidedAt: new Date(now - 100 * 60_000),
        decidedBy: 'u2',
      },
    ]
    for (const data of rows) {
      const r = await db.approval.create({ data })
      cleanup.approvals.push(r.id)
    }

    const overview = await svc.overview(3)
    expect(overview.gates.byStatus.length).toBeGreaterThan(0)

    const approved = overview.gates.byStatus.find(
      (s) => s.status === 'approved',
    )
    expect(approved?.count).toBeGreaterThanOrEqual(1)
    expect(overview.gates.byKind.some((k) => k.kind === 'budgetOverride')).toBe(
      true,
    )

    expect(overview.sla.decidedCount).toBeGreaterThanOrEqual(2)
    expect(overview.sla.medianMinutes ?? 0).toBeGreaterThanOrEqual(0)
    expect(
      (overview.sla.p90Minutes ?? 0) >= (overview.sla.medianMinutes ?? 0),
    ).toBe(true)
  })

  it('breaks agent run outcomes down by skill', async () => {
    const skillTag = `e2e-skill-${suffix}`
    const runs = [
      await db.agentRun.create({
        data: { agentId: 'analytics-agent', skills: [skillTag] },
      }),
      await db.agentRun.create({
        data: {
          agentId: 'analytics-agent',
          skills: [skillTag],
          status: 'succeeded',
          finishedAt: new Date(),
        },
      }),
      await db.agentRun.create({
        data: {
          agentId: 'analytics-agent',
          skills: [skillTag],
          status: 'failed',
          meta: { error: 'boom' },
        },
      }),
    ]
    cleanup.runs.push(...runs.map((r) => r.id))

    const overview = await svc.overview(3)
    const stat = overview.agents.bySkill.find((s) => s.skill === skillTag)
    if (!stat) throw new Error('skill stat missing')
    expect(stat.total).toBe(3)
    expect(stat.succeeded).toBe(1)
    expect(stat.failed).toBe(1)
  })

  it('reports spend utilization per budget', async () => {
    const budget = await db.budget.create({
      data: {
        name: `Analytics budget ${suffix}`,
        costCenter: `AN-${suffix}`,
        period: '2026-08',
        limitMinor: 1_000_00,
        committedMinor: 250_00,
        spentMinor: 100_00,
      },
    })
    cleanup.budgets.push(budget.id)

    const overview = await svc.overview(3)
    const row = overview.spend.find((s) => s.costCenter === `AN-${suffix}`)
    if (!row) throw new Error('spend row missing')
    expect(row.utilizationPct).toBe(10) // 100 / 1000
  })

  it('returns an exception-volume series and a bounded window', async () => {
    const overview = await svc.overview(6)
    expect(overview.window.months).toBe(6)
    expect(Array.isArray(overview.exceptionVolume)).toBe(true)
    for (const point of overview.exceptionVolume) {
      expect(point.month).toMatch(/^\d{4}-\d{2}$/)
      expect(point.count).toBeGreaterThanOrEqual(0)
    }
  })

  it('replays a run trace in chain order', async () => {
    const run = await db.agentRun.create({
      data: {
        agentId: 'trace-agent',
        skills: ['intake-classify'],
        status: 'succeeded',
        finishedAt: new Date(),
      },
    })
    cleanup.runs.push(run.id)
    await db.auditEntry.createMany({
      data: [
        {
          actorId: 'agent:service',
          actorKind: 'agent',
          action: 'intake.classify',
          entity: 'IntakeDocument',
          entityId: 'doc-1',
          runId: run.id,
        },
        {
          actorId: 'agent:service',
          actorKind: 'agent',
          action: 'invoice.register',
          entity: 'Invoice',
          entityId: 'inv-1',
          runId: run.id,
        },
      ],
    })

    const { run: fetched, entries } = await svc.runTrace(run.id)
    expect(fetched?.id).toBe(run.id)
    expect(entries.map((e) => e.action)).toEqual([
      'intake.classify',
      'invoice.register',
    ])
  })
})
