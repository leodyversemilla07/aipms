import './no-database'
import { BadRequestException, ConflictException } from '@nestjs/common'
import type { PolicyKind, Prisma } from '@workspace/db'
import { describe, expect, it, vi } from 'vitest'
import { ensureDefaultThreshold } from '../../../../packages/db/src/seed-policy'
import { PolicyService } from '../../src/policy/policy.service'
import {
  policyScope,
  validatePolicyConfig,
} from '../../src/policy/policy-config'
import {
  POLICY_ORDER,
  resolveEffectivePolicy,
} from '../../src/policy/policy-resolver'

function row(
  id: string,
  version: number,
  config: object = {},
  enabled = true,
  kind = 'threshold',
) {
  return {
    id,
    version,
    config,
    enabled,
    kind,
    name: id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    updatedBy: 'admin',
    supersedesId: null,
  }
}
function fixture(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async ({ where }) =>
    rows
      .filter(
        (r) =>
          r.kind === where.kind &&
          (where.enabled === undefined || r.enabled === where.enabled),
      )
      .sort((a, b) => b.version - a.version),
  )
  const client = {
    policy: {
      findMany,
      findFirst: vi.fn(async (args) => (await findMany(args))[0] ?? null),
      findUnique: vi.fn(
        async ({ where }) => rows.find((r) => r.id === where.id) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        let count = 0
        for (const r of rows)
          if (where.id.in.includes(r.id) && r.enabled) {
            Object.assign(r, data)
            count++
          }
        return { count }
      }),
      create: vi.fn(async ({ data }) => {
        const created = row(
          'created',
          data.version,
          data.config,
          data.enabled,
          data.kind,
        )
        Object.assign(created, data)
        rows.push(created)
        return created
      }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  }
  return {
    rows,
    client: client as unknown as Prisma.TransactionClient,
    mocks: client,
    resolve: (costCenter?: string) =>
      resolveEffectivePolicy(
        'threshold',
        { costCenter },
        client as unknown as Prisma.TransactionClient,
      ),
  }
}

describe('shared policy precedence (injected clients)', () => {
  it('uses highest enabled version, never updatedAt', async () => {
    const old = row('old', 1, { autoApproveUpTo: 1000 })
    old.updatedAt = new Date()
    const f = fixture([
      old,
      row('new', 2, { autoApproveUpTo: 100 }),
      row('draft', 3, {}, false),
    ])
    expect(await f.resolve()).toMatchObject({ id: 'new' })
    expect(f.mocks.policy.findMany).toHaveBeenCalledWith({
      where: { kind: 'threshold', enabled: true },
      orderBy: POLICY_ORDER,
    })
  })

  it('exact scoped policy overrides a newer global; other cost centers use global', async () => {
    const f = fixture([
      row('global', 99, { autoApproveUpTo: 1000 }),
      row('specific', 2, { scope: 'IT-PROD', autoApproveUpTo: 100 }),
    ])
    expect(await f.resolve('IT-PROD')).toMatchObject({
      id: 'specific',
      config: { scope: 'costCenter:IT-PROD' },
    })
    expect(await f.resolve('OTHER')).toMatchObject({ id: 'global' })
    expect(await f.resolve()).toMatchObject({ id: 'global' })
  })

  it('does not use another cost center as a fallback', async () => {
    expect(
      await fixture([row('other', 1, { scope: 'eng' })]).resolve('ops'),
    ).toBeNull()
  })

  it('normalizes the global wildcard for the threshold engine', async () => {
    expect(
      await fixture([row('global', 1, { scope: '*' })]).resolve(),
    ).toMatchObject({ config: {} })
  })

  it('refuses equal-version enabled heads instead of choosing an arbitrary id', async () => {
    await expect(
      fixture([row('a', 2), row('b', 2), row('older', 1)]).resolve(),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('does not let irrelevant tied scopes override an unambiguous applicable rule', async () => {
    expect(
      await fixture([
        row('a', 2, { scope: 'other' }),
        row('b', 2, { scope: 'other' }),
        row('global', 1),
      ]).resolve('eng'),
    ).toMatchObject({ id: 'global' })
  })

  it('refuses malformed current configuration, never falls back to permissive older data', async () => {
    await expect(
      fixture([
        row('old', 1, { autoApproveUpTo: 1000 }),
        row('bad', 2, { autoApproveUpTo: 'unlimited' }),
      ]).resolve(),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('keeps unknown/absent policy conservative', async () => {
    expect(await fixture([]).resolve()).toBeNull()
  })
})

describe('policy bootstrap preservation (injected clients)', () => {
  it('seeds a default only in a genuinely empty threshold series', async () => {
    const f = fixture([])
    const result = await ensureDefaultThreshold(f.client)
    expect(result).toMatchObject({
      enabled: true,
      version: 1,
      config: { autoApproveUpTo: 50_00000 },
    })
    expect(f.mocks.$executeRaw.mock.calls[0]?.[1]).toBe(
      'policy-version:threshold',
    )
  })

  it.each([false, true])(
    'preserves an existing threshold even when enabled=%j',
    async (enabled) => {
      const f = fixture([row('existing', 5, {}, enabled)])
      expect(await ensureDefaultThreshold(f.client)).toMatchObject({
        id: 'existing',
        enabled,
      })
      expect(f.mocks.policy.create).not.toHaveBeenCalled()
    },
  )
})

describe('policy author-time validation', () => {
  it.each([
    ['threshold', { autoApproveUpToMinor: 1000 }],
    ['threshold', { autoApproveUpTo: -1 }],
    ['threshold', { autoApproveUpTo: 1.5 }],
    ['threshold', { budgetRequired: 'false' }],
    ['threshold', { approvalChain: [1] }],
    ['threshold', []],
    ['threshold', { scope: 'costCenter:' }],
    ['preferredVendor', {}],
    ['preferredVendor', { vendorId: 'a', vendor_id: 'b' }],
    ['evaluationCriterion', { criterion: 'mearb' }],
    ['evaluationCriterion', { criterion: 'bestValue', priceWeight: 1.1 }],
    ['taxRule', { vatRateBps: '1200' }],
    ['taxRule', { ewtRatesBps: { goods: -1 } }],
    ['taxRule', { ewtRatesBps: { goods: 1.5 } }],
    ['taxRule', { ewtRatesBps: { goods: 10_001 } }],
    ['taxRule', { scope: 'eng' }],
    ['taxRule', { ewtRatesBps: { unsupported: 100 } }],
  ])('rejects malformed %s configuration %j', (kind, config) => {
    expect(() => validatePolicyConfig(kind as PolicyKind, config)).toThrow(
      BadRequestException,
    )
  })

  it.each(['eng', 'costCenter:eng', ' eng '])(
    'normalizes equivalent scope %j',
    (scope) => {
      expect(policyScope({ scope })).toBe('costCenter:eng')
    },
  )

  it('preserves the supported vendor alias and bounds tax rates', () => {
    expect(
      validatePolicyConfig('preferredVendor', { vendor_id: 'vendor' }),
    ).toEqual({ vendor_id: 'vendor' })
    expect(
      validatePolicyConfig('taxRule', {
        vatRateBps: 0,
        ewtRatesBps: { goods: 10000 },
      }),
    ).toEqual({ vatRateBps: 0, ewtRatesBps: { goods: 10000 } })
  })
})

describe('serialized revision creation (injected transactions)', () => {
  const input = {
    name: 'Replacement',
    kind: 'threshold' as const,
    config: { autoApproveUpTo: 100 },
    updatedBy: 'admin',
  }
  it('allocates max-kind version and retires only enabled same-scope policies', async () => {
    const f = fixture([
      row('old', 1),
      row('other', 8, { scope: 'eng' }),
      row('disabled', 4, {}, false),
    ])
    const result = await new PolicyService().create(input, f.client)
    expect(result).toMatchObject({ version: 9, retiredPolicyIds: ['old'] })
    expect(f.rows.find((r) => r.id === 'old')?.enabled).toBe(false)
    expect(f.rows.find((r) => r.id === 'other')?.enabled).toBe(true)
    expect(f.mocks.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.mocks.policy.findFirst.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('a disabled draft does not retire the active policy', async () => {
    const f = fixture([row('active', 1)])
    expect(
      await new PolicyService().create({ ...input, enabled: false }, f.client),
    ).toMatchObject({ version: 2, retiredPolicyIds: [] })
    expect(f.rows[0]?.enabled).toBe(true)
  })

  it.each([
    row('target', 1, { vendorId: 'v' }, true, 'preferredVendor'),
    row('target', 1, { scope: 'other' }),
  ])('refuses cross-kind or cross-scope supersession %j', async (target) => {
    const f = fixture([target])
    await expect(
      new PolicyService().create(
        { ...input, supersedesId: 'target' },
        f.client,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(f.mocks.policy.create).not.toHaveBeenCalled()
    expect(f.mocks.policy.updateMany).not.toHaveBeenCalled()
  })

  it('refuses a stale supersession target before retirement', async () => {
    const f = fixture([row('target', 1), row('newer', 2)])
    await expect(
      new PolicyService().create(
        { ...input, supersedesId: 'target' },
        f.client,
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(f.mocks.policy.updateMany).not.toHaveBeenCalled()
  })

  it('refuses version overflow before writing', async () => {
    const f = fixture([row('max', 2147483647)])
    await expect(
      new PolicyService().create(input, f.client),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(f.mocks.policy.create).not.toHaveBeenCalled()
  })
})
