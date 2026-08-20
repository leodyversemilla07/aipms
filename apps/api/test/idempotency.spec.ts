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

  it('waits for an in-flight claim instead of returning the marker', async () => {
    const key = `inflight:${suffix}`
    let executions = 0

    const run = (tag: string) =>
      idempotency.run(key, async () => {
        executions += 1
        await new Promise((resolve) => setTimeout(resolve, 150))
        return { value: executions, tag }
      })

    // Two concurrent callers race for the same key: whoever claims runs the
    // work; the other must observe the in-flight marker and wait for the
    // winner's outcome — never the marker itself, never its own fn's result.
    const [first, second] = await Promise.all([run('a'), run('b')])

    expect(first).toEqual(second)
    expect(executions).toBe(1)

    const keys = await db.idempotencyKey.findMany({ where: { key } })
    keyIds.push(...keys.map((k) => k.id))
  })

  it('re-claims and runs when the winner fails and releases the key', async () => {
    const key = `failed-winner:${suffix}`
    let attempts = 0

    const first = idempotency.run(key, async () => {
      attempts += 1
      throw new Error('boom')
    })
    await expect(first).rejects.toThrow('boom')

    const retry = await idempotency.run(key, async () => {
      attempts += 1
      return { recovered: true }
    })

    expect(retry).toEqual({ recovered: true })
    expect(attempts).toBe(2)

    const keys = await db.idempotencyKey.findMany({ where: { key } })
    keyIds.push(...keys.map((k) => k.id))
  })
})
