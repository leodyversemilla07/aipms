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

  it('bridges a classified doc to an invoice: status + invoice ref', async () => {
    const hash = `sha256-${suffix}-bridge`
    const doc = await intakeService.ingest({ channel, contentHash: hash })
    intakeIds.push(doc.id)
    await intakeService.classify({
      id: doc.id,
      classified: { vendorId: 'v-1', number: 'INV-1' },
    })

    // matched invoice -> document progresses to matched, ref recorded
    const bridged = await intakeService.attachInvoice(
      doc.id,
      'invoice-1',
      'matched',
    )
    expect(bridged.status).toBe('matched')
    expect((bridged.classified as Record<string, unknown>).invoiceId).toBe(
      'invoice-1',
    )

    // exception invoice -> document flagged exception
    const doc2 = await intakeService.ingest({
      channel,
      contentHash: `${hash}-2`,
    })
    intakeIds.push(doc2.id)
    await intakeService.attachInvoice(doc2.id, 'invoice-2', 'exception')
    expect((await intakeService.detail(doc2.id)).status).toBe('exception')

    // dropped doc cannot bridge
    const doc3 = await intakeService.ingest({
      channel,
      contentHash: `${hash}-3`,
    })
    intakeIds.push(doc3.id)
    await intakeService.drop(doc3.id)
    await expect(
      intakeService.attachInvoice(doc3.id, 'invoice-3', 'matched'),
    ).rejects.toThrow()
  })
})
