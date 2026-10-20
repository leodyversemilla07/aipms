import { Injectable } from '@nestjs/common'
import { db, isSqlite, Prisma } from '@workspace/db'

/**
 * §14 observability — deterministic aggregations over existing domain
 * tables. No new state: every figure derives from AuditEntry, Approval,
 * Requisition, Budget, and AgentRun at query time.
 */

export interface OverviewWindow {
  months: number
  since: string
}

export interface GateStats {
  /** decision status → count within the window */
  byStatus: { status: string; count: number }[]
  /** gate kind × decision status */
  byKind: { kind: string; status: string; count: number }[]
}

export interface ApprovalSla {
  decidedCount: number
  medianMinutes: number | null
  p90Minutes: number | null
}

export interface MonthCount {
  month: string
  count: number
}

export interface SpendRow {
  costCenter: string
  period: string
  limitMinor: number
  committedMinor: number
  spentMinor: number
  /** spent / limit, percent rounded to one decimal */
  utilizationPct: number
}

export interface SkillStat {
  skill: string
  total: number
  succeeded: number
  failed: number
}

export interface Overview {
  window: OverviewWindow
  gates: GateStats
  sla: ApprovalSla
  exceptionVolume: MonthCount[]
  spend: SpendRow[]
  agents: {
    total: number
    succeeded: number
    failed: number
    running: number
    bySkill: SkillStat[]
  }
}

interface LatencyRow {
  count: bigint
  medianMinutes: number | null
  p90Minutes: number | null
}

/** Linear-interpolation percentile, matching PostgreSQL's `percentile_cont`. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower]
  const high = sorted[upper]
  if (low === undefined || high === undefined) return null
  if (lower === upper) return low
  return low + (high - low) * (position - lower)
}

@Injectable()
export class AnalyticsService {
  private since(months: number): Date {
    return new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000)
  }

  /**
   * Approval latency percentiles. PostgreSQL computes them in the database so
   * a wide window never has to be materialised in API memory; the local
   * SQLite environment has no `percentile_cont`, so it computes the same
   * percentiles (linear interpolation) from the rows.
   */
  private async approvalLatency(since: Date): Promise<LatencyRow[]> {
    if (isSqlite()) {
      const rows = await db.approval.findMany({
        where: {
          createdAt: { gte: since },
          status: { in: ['approved', 'rejected', 'overridden'] },
          decidedAt: { not: null },
        },
        select: { createdAt: true, decidedAt: true },
      })
      const minutes: number[] = []
      for (const row of rows) {
        if (!row.decidedAt || row.decidedAt < row.createdAt) continue
        minutes.push(
          (row.decidedAt.getTime() - row.createdAt.getTime()) / 60000,
        )
      }
      minutes.sort((a, b) => a - b)
      return [
        {
          count: BigInt(minutes.length),
          medianMinutes: percentile(minutes, 0.5),
          p90Minutes: percentile(minutes, 0.9),
        },
      ]
    }
    return db.$queryRaw<LatencyRow[]>(Prisma.sql`
      select count(*)::bigint as count,
             percentile_cont(0.5) within group (
               order by extract(epoch from ("decidedAt" - "createdAt")) / 60
             )::float8 as "medianMinutes",
             percentile_cont(0.9) within group (
               order by extract(epoch from ("decidedAt" - "createdAt")) / 60
             )::float8 as "p90Minutes"
      from approval
      where "createdAt" >= ${since}
        and status in ('approved', 'rejected', 'overridden')
        and "decidedAt" is not null
        and "decidedAt" >= "createdAt"
    `)
  }

  /** Monthly exception volume across the whole window. */
  private async monthlyExceptions(
    since: Date,
  ): Promise<{ month: string; count: bigint }[]> {
    if (isSqlite()) {
      return db.$queryRaw<{ month: string; count: bigint }[]>(Prisma.sql`
        select strftime('%Y-%m', "createdAt") as month,
               count(*) as count
        from requisition
        where status = 'exception'
          and "createdAt" >= ${since}
        group by 1
        order by 1
      `)
    }
    return db.$queryRaw<{ month: string; count: bigint }[]>(Prisma.sql`
      select to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as month,
             count(*)::bigint as count
      from requisition
      where status = 'exception'
        and "createdAt" >= ${since}
      group by 1
      order by 1
    `)
  }

  /** Agent runs grouped by the skill bundle that was active. */
  private async skillStats(since: Date): Promise<SkillStat[]> {
    if (isSqlite()) {
      return db.$queryRaw<SkillStat[]>(Prisma.sql`
        select s.value as "skill",
               count(*) as total,
               sum(case when status = 'succeeded' then 1 else 0 end) as succeeded,
               sum(case when status = 'failed' then 1 else 0 end) as failed
        from "agentRun", json_each("skills") as s
        where "startedAt" >= ${since}
        group by s.value
        order by total desc
      `)
    }
    return db.$queryRaw<SkillStat[]>(Prisma.sql`
      select s as "skill",
             count(*)::int as total,
             sum(case when status = 'succeeded' then 1 else 0 end)::int as succeeded,
             sum(case when status = 'failed' then 1 else 0 end)::int as failed
      from "agentRun", jsonb_array_elements_text("skills") as s
      where "startedAt" >= ${since}
      group by s
      order by total desc
    `)
  }

  async overview(monthsIn: number): Promise<Overview> {
    const months = Math.min(Math.max(Math.trunc(monthsIn) || 3, 1), 12)
    const since = this.since(months)

    const [gateRows, latencyRows, exceptions, budgets, runCounts, bySkill] =
      await Promise.all([
        db.approval.groupBy({
          by: ['kind', 'status'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.approvalLatency(since),
        this.monthlyExceptions(since),
        db.budget.findMany({
          where: { updatedAt: { gte: since } },
          orderBy: [{ costCenter: 'asc' }, { period: 'desc' }],
          take: 1_000,
        }),
        db.agentRun.groupBy({
          by: ['status'],
          where: { startedAt: { gte: since } },
          _count: { _all: true },
        }),
        this.skillStats(since),
      ])

    const byStatus = new Map<string, number>()
    const byKind: GateStats['byKind'] = []
    for (const row of gateRows) {
      byStatus.set(
        row.status,
        (byStatus.get(row.status) ?? 0) + row._count._all,
      )
      byKind.push({
        kind: row.kind,
        status: row.status,
        count: row._count._all,
      })
    }

    const latency = latencyRows[0]

    const runStatus = new Map(
      runCounts.map((r) => [r.status, r._count._all] as const),
    )

    return {
      window: { months, since: since.toISOString() },
      gates: {
        byStatus: [...byStatus.entries()].map(([status, count]) => ({
          status,
          count,
        })),
        byKind,
      },
      sla: {
        decidedCount: Number(latency?.count ?? 0),
        medianMinutes:
          latency?.medianMinutes == null
            ? null
            : Math.round(latency.medianMinutes),
        p90Minutes:
          latency?.p90Minutes == null ? null : Math.round(latency.p90Minutes),
      },
      exceptionVolume: exceptions.map((r) => ({
        month: r.month,
        count: Number(r.count),
      })),
      spend: budgets.map((b) => ({
        costCenter: b.costCenter,
        period: b.period,
        limitMinor: b.limitMinor,
        committedMinor: b.committedMinor,
        spentMinor: b.spentMinor,
        utilizationPct:
          b.limitMinor > 0
            ? Math.round((b.spentMinor / b.limitMinor) * 1000) / 10
            : 0,
      })),
      agents: {
        total: runCounts.reduce((s, r) => s + r._count._all, 0),
        succeeded: runStatus.get('succeeded') ?? 0,
        failed: runStatus.get('failed') ?? 0,
        running: runStatus.get('running') ?? 0,
        bySkill,
      },
    }
  }

  /**
   * §14 run trace — one agent execution replayed: every audited action that
   * carries its runId, ordered by the tamper-evident chain sequence.
   */
  async runTrace(runId: string) {
    const [run, entries] = await Promise.all([
      db.agentRun.findUnique({ where: { id: runId } }),
      db.auditEntry.findMany({
        where: { runId },
        orderBy: { seq: 'asc' },
        select: {
          seq: true,
          actorId: true,
          actorKind: true,
          action: true,
          entity: true,
          entityId: true,
          at: true,
        },
      }),
    ])
    return { run, entries }
  }
}
