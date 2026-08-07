import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common'
import { db } from '@workspace/db'
import { IntakeService } from '../intake/intake.service'
import { InvoiceService } from '../invoice/invoice.service'
import { extractStructuredInvoice } from './extract'
import { type InvoicePayload, invoicePayloadSchema } from './invoice-payload'

export const AGENT_EXTRACTOR = 'AGENT_EXTRACTOR'

/** Extraction seam: shape a raw document into a classified invoice payload. */
export type Extractor = (raw: unknown) => InvoicePayload

/**
 * §3 Phase-3 domain agent. Owns the classify→register pipeline an LLM agent
 * would otherwise drive: take a raw intake document, extract & validate an
 * invoice payload, classify the document, then register (tax computed by the
 * engine, §9 match run). Extraction is a dependency seam (AGENT_EXTRACTOR);
 * the default is the deterministic structured extractor, and an LLM provider
 * can be injected without changing the pipeline.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly intake: IntakeService,
    private readonly invoice: InvoiceService,
    @Optional()
    @Inject(AGENT_EXTRACTOR)
    private readonly extractor?: Extractor,
  ) {}

  async classifyAndRegister(docId: string) {
    const doc = await this.intake.detail(docId)
    if (doc.status === 'dropped') {
      throw new ConflictException(
        'Dropped document cannot be processed by the agent',
      )
    }

    const extract = this.extractor ?? extractStructuredInvoice
    const classified = extract(doc.raw)

    // write the extraction (classify) — moves doc to `extracted`
    await this.intake.classify({ id: docId, classified })

    // register — engine derives VAT/EWT (§8.4) and runs the §9 match,
    // dedupe on [vendorId, number] makes re-run safe.
    const payload = invoicePayloadSchema.parse(classified)
    const { invoice, match } = await this.invoice.register(payload)
    const invoiceId = (invoice as { id: string }).id
    const invoiceStatus = (invoice as { status: string }).status

    const bridged = await this.intake.attachInvoice(
      docId,
      invoiceId,
      invoiceStatus,
    )
    return { doc: bridged, invoice, match }
  }

  /**
   * Batch runner — process `limit` pending (`new`) documents through the
   * pipeline. The seam a worker/loop (or the eve runtime) will call to keep
   * the queue draining; per-doc failures are isolated and reported, not
   * fatal, and re-runs are safe because InvoiceService dedupes.
   */
  async processPending(limit: number) {
    const docs = await db.intakeDocument.findMany({
      where: { status: 'new' },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    })
    let succeeded = 0
    const failed: Array<{ docId: string; error: string }> = []
    for (const doc of docs) {
      try {
        await this.classifyAndRegister(doc.id)
        succeeded += 1
      } catch (error) {
        failed.push({ docId: doc.id, error: (error as Error).message })
      }
    }
    return { documents: docs.length, succeeded, failed }
  }
}
