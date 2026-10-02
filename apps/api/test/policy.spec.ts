import { randomUUID } from 'node:crypto'
import { BadRequestException, ConflictException } from '@nestjs/common'
import { db } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PolicyRouter } from '../src/policy/policy.router'
import {
  type CreatePolicyInput,
  PolicyService,
} from '../src/policy/policy.service'
import { AuditService } from '../src/shared/audit/audit.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../src/trpc/context.types'
import { capturePolicyActivation } from './policy-activation.fixture'

const prefix = `policy-${randomUUID()}`
const ids: string[] = []
let restorePolicies = async () => {}
const policy = new PolicyService()
beforeAll(async () => {
  restorePolicies = await capturePolicyActivation()
})
afterAll(async () => {
  await db.policy.deleteMany({ where: { id: { in: ids } } })
  await restorePolicies()
  await db.$disconnect()
})
async function create(extra: Partial<CreatePolicyInput> = {}) {
  const result = await policy.create({
    name: prefix,
    kind: 'threshold',
    config: { autoApproveUpTo: 100 },
    updatedBy: prefix,
    ...extra,
  })
  ids.push(result.id)
  return result
}

describe('PolicyService revision integrity (PostgreSQL)', () => {
  it('allocates monotonic versions and retires enabled predecessors', async () => {
    const before = await policy.latest('threshold', false)
    const first = await create()
    expect(first.version).toBe((before?.version ?? 0) + 1)
    const second = await create({ supersedesId: first.id })
    expect(second.version).toBe(first.version + 1)
    expect(second.supersedesId).toBe(first.id)
    expect(second.retiredPolicyIds).toContain(first.id)
    expect(
      await db.policy.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ enabled: false })
    expect((await policy.activeByKind()).threshold?.id).toBe(second.id)
    const evaluation = await create({
      kind: 'evaluationCriterion',
      config: { criterion: 'bestValue', priceWeight: 0.3 },
    })
    expect((await policy.activeByKind()).evaluationCriterion?.id).toBe(
      evaluation.id,
    )
  })

  it('records retirement in the atomic audit and replays without allocating another revision', async () => {
    const prior = await create()
    const router = new PolicyRouter(
      policy,
      new IdempotencyService(),
      new AuditService(),
    )
    const input = {
      name: prefix,
      kind: 'threshold' as const,
      config: { autoApproveUpTo: 10 },
      enabled: true,
      supersedesId: prior.id,
      idempotencyKey: randomUUID(),
    }
    const ctx = {
      user: { id: prefix, role: 'admin' },
      actorKind: 'human',
    } as unknown as AuthedTrpcContext
    const first = await router.create(input, ctx)
    ids.push(first.id)
    const replay = await router.create(input, ctx)
    expect(replay.id).toBe(first.id)
    expect(replay.version).toBe(first.version)
    expect((await policy.latest('threshold', false))?.id).toBe(first.id)
    const audit = await db.auditEntry.findFirstOrThrow({
      where: { action: 'policy.create', entityId: first.id },
    })
    expect(audit.after).toMatchObject({
      retiredPolicyIds: expect.arrayContaining([prior.id]),
      version: first.version,
    })
    expect(
      await db.auditEntry.count({
        where: { action: 'policy.create', entityId: first.id },
      }),
    ).toBe(1)
  })

  it('does not activate disabled drafts or retire the current active revision', async () => {
    const active = await policy.latest('threshold')
    const draft = await create({ enabled: false })
    expect(draft.retiredPolicyIds).toEqual([])
    expect((await policy.latest('threshold'))?.id).toBe(active?.id)
    expect((await policy.latest('threshold', false))?.id).toBe(draft.id)
  })

  it('parallel standalone creators allocate distinct consecutive versions', async () => {
    const previous = await policy.latest('threshold', false)
    const created = await Promise.all(Array.from({ length: 6 }, () => create()))
    const versions = created.map((row) => row.version).sort((a, b) => a - b)
    expect(versions).toEqual(
      Array.from({ length: 6 }, (_, i) => (previous?.version ?? 0) + i + 1),
    )
    expect(
      await db.policy.count({
        where: { id: { in: created.map((row) => row.id) }, enabled: true },
      }),
    ).toBe(1)
  })

  it('competing replacements of the same optimistic head cannot fork', async () => {
    const head = await create()
    const outcomes = await Promise.allSettled([
      create({ supersedesId: head.id }),
      create({ supersedesId: head.id }),
    ])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = outcomes.find((r) => r.status === 'rejected')
    expect(
      failed && failed.status === 'rejected' && failed.reason,
    ).toBeInstanceOf(ConflictException)
  })

  it('refuses cross-kind, cross-scope, missing, and stale supersession references', async () => {
    const head = await create()
    const vendor = await create({
      kind: 'preferredVendor',
      config: { vendorId: 'fixture-vendor' },
    })
    const scoped = await create({
      config: { scope: `${prefix}-scope`, autoApproveUpTo: 100 },
    })
    await expect(create({ supersedesId: vendor.id })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(create({ supersedesId: scoped.id })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(create({ supersedesId: randomUUID() })).rejects.toThrow(
      /not found/,
    )
    await create({ supersedesId: head.id })
    await expect(create({ supersedesId: head.id })).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('a failed surrounding transaction restores activation and consumes no revision', async () => {
    const head = await create()
    const rollback = new Error('rollback revision')
    await expect(
      db.$transaction(async (tx) => {
        await policy.create(
          {
            name: prefix,
            kind: 'threshold',
            config: {},
            updatedBy: prefix,
            supersedesId: head.id,
          },
          tx,
        )
        throw rollback
      }),
    ).rejects.toBe(rollback)
    expect((await policy.latest('threshold'))?.id).toBe(head.id)
    expect(
      (await db.policy.findUniqueOrThrow({ where: { id: head.id } })).enabled,
    ).toBe(true)
    expect((await create()).version).toBe(head.version + 1)
  })

  it('resolves exact scopes ahead of global without retiring other scopes', async () => {
    const scoped = await create({
      config: { scope: `${prefix}-specific`, autoApproveUpTo: 1 },
    })
    const global = await create({ config: { autoApproveUpTo: 1000 } })
    expect(global.version).toBeGreaterThan(scoped.version)
    expect(
      (await policy.resolve('threshold', { costCenter: `${prefix}-specific` }))
        ?.id,
    ).toBe(scoped.id)
    expect(
      (await policy.resolve('threshold', { costCenter: 'elsewhere' }))?.id,
    ).toBe(global.id)
    expect(
      (await db.policy.findUniqueOrThrow({ where: { id: scoped.id } })).enabled,
    ).toBe(true)
  })

  it('refuses tied legacy heads until a reviewed newer replacement is published', async () => {
    const prior = await policy.latest('threshold', false)
    const version = (prior?.version ?? 0) + 1
    const scope = `${prefix}-legacy`
    const legacy = await Promise.all(
      ['a', 'b'].map((tag) =>
        db.policy.create({
          data: {
            name: `${prefix}-${tag}`,
            kind: 'threshold',
            version,
            enabled: true,
            config: { scope, autoApproveUpTo: 1000 },
            updatedBy: prefix,
          },
        }),
      ),
    )
    ids.push(...legacy.map((row) => row.id))
    await expect(
      policy.resolve('threshold', { costCenter: scope }),
    ).rejects.toBeInstanceOf(ConflictException)
    const replacement = await create({ config: { scope, autoApproveUpTo: 1 } })
    expect(replacement.version).toBe(version + 1)
    expect(replacement.retiredPolicyIds.sort()).toEqual(
      legacy.map((row) => row.id).sort(),
    )
    expect((await policy.resolve('threshold', { costCenter: scope }))?.id).toBe(
      replacement.id,
    )
  })
})
