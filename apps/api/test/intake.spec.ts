import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { IntakeService } from '../src/intake/intake.service'

/**
 * @workspace intake service — §8.2 normalized ingestion queue against local
 * Postgres (dedupe on [channel, contentHash], classify/requeue/drop).
 */

const suffix = Math.random().toString(36).slice(2, 8)
const intakeIds: string[] = []

const intakeService = new IntakeService()

afterAll(async () => {
  await db.intakeDocument.deleteMany({ where: { id: { in: intakeIds } } })
  await db.$disconnect()
})

describe('Intake queue (§8.2)', () => {
  const channel = `EMAIL_IMAP-${suffix}`

  it('ingests, dedupes, classifies, requeues, and drops', async () => {
    const hash = `sha256-${suffix}-doc`
    const first = await intakeService.ingest({ channel, contentHash: hash })
    intakeIds.push(first.id)
    expect(first.status).toBe('new')

    // idempotent re-ingest returns the same row
    const dup = await intakeService.ingest({ channel, contentHash: hash })
    expect(dup.id).toBe(first.id)

    const classified = await intakeService.classify({
      id: first.id,
      classified: { docType: 'invoice', vendor: 'Acme' },
    })
    expect(classified.status).toBe('extracted')

    const requeued = await intakeService.requeue(first.id)
    expect(requeued.status).toBe('new')
    expect(requeued.classified).toBeNull()

    const dropped = await intakeService.drop(first.id)
    expect(dropped.status).toBe('dropped')
  })
})
