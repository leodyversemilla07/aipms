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

type AgentRunListRow = Prisma.AgentRunGetPayload<object>

/**
 * §3 Phase-3 internal domain agent. Owns the classify→register pipeline an LLM agent
 * would otherwise drive: take a raw intake document, extract & validate an
 * invoice payload, classify the document, then register (tax computed by the
 * engine, §9 match run). Extraction is a dependency seam (AGENT_EXTRACTOR);
 * the default is the deterministic structured extractor, and an LLM provider
 * can be injected without changing the pipeline. External callers use
 * AgentCommandService so authorization and audit cannot be bypassed.
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
   * §7.1 run history — the supervisory surface over what agents actually
   * did (status, skills, trigger metadata). Newest first.
   */
  listRuns(
    input: Partial<ListInput> & {
      status?: 'running' | 'succeeded' | 'failed' | 'cancelled'
    } = {},
  ): Promise<ListResult<AgentRunListRow>> {
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
