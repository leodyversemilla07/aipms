import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'

/**
 * @workspace idempotency claim protocol (§9) against local Postgres.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const keyIds: string[] = []

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { id: { in: keyIds } } })
  await db.$disconnect()
})

describe('IdempotencyService (§9)', () => {
  const idempotency = new IdempotencyService()

  it('returns the stored outcome on key replay instead of re-running', async () => {
    let executions = 0
    const run = (key: string) =>
      idempotency.run(key, async () => {
        executions += 1
        return { value: executions }
      })

    const first = await run(`catalog.create:${suffix}`)
    const replay = await run(`catalog.create:${suffix}`)

    expect(first).toEqual({ value: 1 })
    expect(replay).toEqual({ value: 1 })
    expect(executions).toBe(1)

    const keys = await db.idempotencyKey.findMany({
      where: { key: `catalog.create:${suffix}` },
    })
    keyIds.push(...keys.map((k) => k.id))
  })
})
