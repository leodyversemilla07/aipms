import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { IntakeService } from '../intake/intake.service'
import { InvoiceService } from '../invoice/invoice.service'
import type { ListInput, ListResult } from '../trpc/list-input'
import { paginate } from '../trpc/list-input'
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

  async classifyAndRegister(docId: string, outerTx?: Prisma.TransactionClient) {
    // Pure extraction first (no I/O): the transaction below then covers
    // classify → register → bridge atomically.
    const preview = await this.intake.detail(docId)
    if (preview.status === 'dropped') {
      throw new ConflictException(
        'Dropped document cannot be processed by the agent',
      )
    }
    const extract = this.extractor ?? extractStructuredInvoice
    const classified = extract(preview.raw)
    const payload = invoicePayloadSchema.parse(classified)

    const run = async (tx: Prisma.TransactionClient) => {
      const doc = await tx.intakeDocument.findUnique({
        where: { id: docId },
      })
      if (!doc) throw new ConflictException(`Document ${docId} not found`)
      if (doc.status === 'dropped') {
        throw new ConflictException(
          'Dropped document cannot be processed by the agent',
        )
      }
      await this.intake.classify({ id: docId, classified }, tx)
      // register — engine derives VAT/EWT (§8.4) and runs the §9 match,
      // dedupe on [vendorId, number] makes re-run safe.
      const { invoice, match } = await this.invoice.register(payload, tx)
      const invoiceId = (invoice as { id: string }).id
      const invoiceStatus = (invoice as { status: string }).status
      const bridged = await this.intake.attachInvoice(
        docId,
        invoiceId,
        invoiceStatus,
        tx,
      )
      return { doc: bridged, invoice, match }
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /**
   * Batch runner — process `limit` pending (`new`) documents through the
   * pipeline. The seam a worker/loop (or the eve runtime) will call to keep
   * the queue draining; per-doc failures are isolated and reported, not
   * fatal, and re-runs are safe because InvoiceService dedupes.
   */
  async processPending(limit: number, outerTx?: Prisma.TransactionClient) {
    const docs = await db.intakeDocument.findMany({
      where: { status: 'new' },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    })
    let succeeded = 0
    const failed: Array<{ docId: string; error: string }> = []
    // A caller-supplied transaction makes the whole batch atomic; otherwise
    // each document commits independently so one bad document cannot block
    // the queue (per-doc failures are reported, not fatal).
    const runOne = (docId: string, tx?: Prisma.TransactionClient) =>
      this.classifyAndRegister(docId, tx)
    if (outerTx) {
      for (const doc of docs) {
        await runOne(doc.id, outerTx)
        succeeded += 1
      }
      return { documents: docs.length, succeeded, failed }
    }
    for (const doc of docs) {
      try {
        await runOne(doc.id)
        succeeded += 1
      } catch (error) {
        failed.push({ docId: doc.id, error: (error as Error).message })
      }
    }
    return { documents: docs.length, succeeded, failed }
  }

  /**
   * §7.1 run history — the supervisory surface over what agents actually
   * did (status, skills, trigger metadata). Newest first.
   */
  listRuns(
    input: Partial<ListInput> & {
      status?: 'running' | 'succeeded' | 'failed' | 'cancelled'
    } = {},
  ): Promise<ListResult<object>> {
    const { skip, take } = paginate({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    })
    const where = input.status ? { status: input.status } : {}
    return Promise.all([
      db.agentRun.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
      }),
      db.agentRun.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }
}
