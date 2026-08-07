import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentService } from '../src/agent/agent.service'
import { extractStructuredInvoice } from '../src/agent/extract'
import { IntakeService } from '../src/intake/intake.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PolicyService } from '../src/policy/policy.service'

/**
 * @workspace agent service — §3 classify→register pipeline with the
 * deterministic structured extractor, against local Postgres.
 */
const suffix = Math.random().toString(36).slice(2, 8)
const vendorId = `agent-vendor-${suffix}`
let invoiceIds: string[] = []
let intakeIds: string[] = []

const policy = new PolicyService()
const invoice = new InvoiceService(policy)
const intake = new IntakeService()
const agent = new AgentService(intake, invoice, extractStructuredInvoice)

beforeEach(() => {
  invoiceIds = []
  intakeIds = []
})

afterAll(async () => {
  await db.invoice.deleteMany({ where: { id: { in: invoiceIds } } })
  await db.intakeDocument.deleteMany({ where: { id: { in: intakeIds } } })
  await db.$disconnect()
})

describe('Agent pipeline (§3 classify→register)', () => {
  it('extracts a structured raw, classifies, and registers an invoice', async () => {
    const number = `AG-${suffix}`
    const doc = await intake.ingest({
      channel: 'API',
      contentHash: `sha256-${suffix}-agent`,
      raw: {
        docType: 'invoice',
        payload: {
          vendorId,
          number,
          lines: [
            { amountMinor: 500_000, class: 'goods' },
            { amountMinor: 250_000, class: 'services' },
          ],
        },
      },
    })
    intakeIds.push(doc.id)

    const res = await agent.classifyAndRegister(doc.id)
    const inv = res.invoice as { id: string; number: string; status: string }
    invoiceIds.push(inv.id)

    // Engine derives VAT/EWT; no PO so it lands as received.
    expect(inv.number).toBe(number)
    expect(inv.status).toBe('received')

    // Document progressed and carries the invoice reference.
    const updated = await db.intakeDocument.findUnique({
      where: { id: doc.id },
    })
    expect(updated?.status).toBe('extracted')
    expect((updated?.classified as Record<string, unknown>)?.invoiceId).toBe(
      inv.id,
    )

    // Idempotent — re-classifying returns the same invoice, no duplicate row.
    await agent.classifyAndRegister(doc.id)
    const count = await db.invoice.count({
      where: { vendorId, number },
    })
    expect(count).toBe(1)
  })

  it('rejects a dropped document', async () => {
    const doc = await intake.ingest({
      channel: 'agent',
      contentHash: `sha256-${suffix}-agent-drop`,
      raw: {
        docType: 'invoice',
        payload: {
          vendorId,
          number: `AG-DROP-${suffix}`,
          lines: [{ amountMinor: 1, class: 'goods' }],
        },
      },
    })
    intakeIds.push(doc.id)
    await intake.drop(doc.id)
    await expect(agent.classifyAndRegister(doc.id)).rejects.toThrow()
  })
})
