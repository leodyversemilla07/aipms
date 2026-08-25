import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ApprovalSlaService,
  resolveSlaHours,
} from '../src/approval/approval-sla.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * §10.3 approval SLA escalation — overdue pending approvals get escalatedAt
 * + an outbox `approval.slaBreached` event; decided approvals are untouched;
 * sweeps are idempotent. Against local Postgres.
 */

const created: { approvals: string[]; events: string[] } = {
  approvals: [],
  events: [],
}

const sla = new ApprovalSlaService(new EventEmitterService())

afterAll(async () => {
  await db.domainEvent.deleteMany({ where: { id: { in: created.events } } })
  await db.approval.deleteMany({ where: { id: { in: created.approvals } } })
  await db.$disconnect()
})

beforeAll(() => {
  process.env.AIPMS_APPROVAL_SLA_HOURS = '48'
})

afterAll(() => {
  delete process.env.AIPMS_APPROVAL_SLA_HOURS
})

function makeApproval(createdAt: Date) {
  return db.approval
    .create({
      data: {
        kind: 'threshold',
        route: ['manager'],
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
      },
    })
    .then((a) => {
      created.approvals.push(a.id)
      return a
    })
}

describe('approval SLA escalation (§10.3)', () => {
  it('stamps escalatedAt and emits the breach event for overdue pendings only', async () => {
    const now = new Date()
    const staleAt = new Date(now.getTime() - 72 * 3_600_000)
    const freshAt = new Date(now.getTime() - 1 * 3_600_000)

    const stale = await makeApproval(staleAt)
    const fresh = await makeApproval(freshAt)

    const count = await sla.sweep(now)
    expect(count).toBeGreaterThanOrEqual(1)

    const escalated = await db.approval.findUnique({ where: { id: stale.id } })
    expect(escalated?.escalatedAt).toBeTruthy()

    const untouched = await db.approval.findUnique({ where: { id: fresh.id } })
    expect(untouched?.escalatedAt).toBeNull()

    const event = await db.domainEvent.findFirst({
      where: { type: 'approval.slaBreached', entityId: stale.id },
    })
    expect(event).toBeTruthy()
    if (!event) throw new Error('expected breach event')
    created.events.push(event.id)
    expect(event.payload).toMatchObject({ slaHours: 48 })

    // Idempotent: a second sweep does not re-escalate.
    const second = await sla.sweep(new Date(now.getTime() + 60_000))
    void second
    const again = await db.domainEvent.count({
      where: { type: 'approval.slaBreached', entityId: stale.id },
    })
    expect(again).toBe(1)
  })

  it('never escalates decided approvals even when ancient', async () => {
    const now = new Date()
    const decided = await makeApproval(
      new Date(now.getTime() - 720 * 3_600_000),
    )
    await db.approval.update({
      where: { id: decided.id },
      data: { status: 'approved', decidedBy: 'someone', decidedAt: now },
    })

    await sla.sweep(now)
    const row = await db.approval.findUnique({ where: { id: decided.id } })
    expect(row?.escalatedAt).toBeNull()
  })

  it('resolves the SLA window from env with a sane default and disable', () => {
    expect(resolveSlaHours({})).toBe(48)
    expect(resolveSlaHours({ AIPMS_APPROVAL_SLA_HOURS: '24' })).toBe(24)
    expect(resolveSlaHours({ AIPMS_APPROVAL_SLA_HOURS: '0' })).toBe(0)
    expect(resolveSlaHours({ AIPMS_APPROVAL_SLA_HOURS: 'nonsense' })).toBe(48)
    expect(resolveSlaHours({ AIPMS_APPROVAL_SLA_HOURS: '-4' })).toBe(48)
  })
})
