import { createHash } from 'node:crypto'
import { ConflictException, Inject } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { invoicePayloadSchema as classifiedInvoiceSchema } from '../agent/invoice-payload'
import { InvoiceService } from '../invoice/invoice.service'
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { IntakeService } from './intake.service'
import { parseStructuredInvoice } from './structured-invoice'

const ingestInput = z.object({
  idempotencyKey: z.string().min(1),
  channel: z.string().min(1).max(40),
  contentHash: z.string().min(1).max(128),
  senderId: z.string().min(1).optional(),
  raw: z.unknown().optional(),
})

const classifyInput = z.object({
  id: z.string().min(1),
  classified: z.unknown(),
})

const listInputWithStatus = listInput.extend({
  status: z
    .enum([
      'new',
      'classifying',
      'extracted',
      'matched',
      'exception',
      'dropped',
    ])
    .optional(),
})

const idInput = z.object({ id: z.string().min(1) })

const bridgeInput = idInput.extend({ idempotencyKey: z.string().min(1) })

// §8.2 structured channels — machine formats parsed deterministically on
// receive (no LLM); documents enter the queue pre-extracted.
const ingestStructuredInput = z.object({
  idempotencyKey: z.string().min(1),
  channel: z.enum(['EINVOICE_EIS', 'PEPPOL_UBL']),
  content: z.string().min(1),
  senderId: z.string().min(1).optional(),
})

@Router({ alias: 'intake' })
@UseMiddlewares(AuthMiddleware)
export class IntakeRouter {
  constructor(
    @Inject(IntakeService) private readonly intake: IntakeService,
    @Inject(InvoiceService) private readonly invoice: InvoiceService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInputWithStatus })
  async list(@Input() input: z.infer<typeof listInputWithStatus>) {
    return this.intake.list(input.status ? { status: input.status } : {})
  }

  @Mutation({ input: ingestInput })
  async ingest(
    @Input() input: z.infer<typeof ingestInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const doc = await this.intake.ingest(input)
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'intake.ingest',
        entity: 'IntakeDocument',
        entityId: doc.id,
        input,
      })
      return doc
    })
  }

  /**
   * §8.2 structured e-invoicing: parse a BIR EIS JSON or Peppol UBL XML
   * document deterministically and ingest it pre-extracted. Dedupe is over
   * the raw content hash, so re-transmission of the same file is a no-op.
   */
  @Mutation({ input: ingestStructuredInput })
  async ingestStructured(
    @Input() input: z.infer<typeof ingestStructuredInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const classified = parseStructuredInvoice(input.channel, input.content)
      const contentHash = createHash('sha256')
        .update(input.content)
        .digest('hex')
      const doc = await this.intake.ingest({
        channel: input.channel,
        contentHash,
        senderId: input.senderId ?? null,
        raw: input.content.length <= 262144 ? input.content : undefined,
      })
      const extracted = await this.intake.classify({ id: doc.id, classified })
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'intake.ingestStructured',
        entity: 'IntakeDocument',
        entityId: doc.id,
        input: { channel: input.channel, contentHash },
        after: { status: extracted.status },
      })
      return extracted
    })
  }

  @Mutation({ input: classifyInput })
  async classify(
    @Input() input: z.infer<typeof classifyInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.classify(input)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'intake.classify',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
      after: doc,
    })
    return doc
  }

  @Mutation({ input: idInput })
  async drop(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.drop(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'intake.drop',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
    })
    return doc
  }

  @Mutation({ input: idInput })
  async requeue(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const doc = await this.intake.requeue(input.id)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'intake.requeue',
      entity: 'IntakeDocument',
      entityId: doc.id,
      input,
    })
    return doc
  }

  /**
   * §9 bridge: promote a classified invoice document to a registered invoice.
   * The payload was written by classify (or the extraction agent); the engine
   * derives VAT/EWT and runs the three-way match. Idempotent — InvoiceService
   * dedupes on [vendorId, number], so a re-run returns the existing invoice.
   */
  @Mutation({ input: bridgeInput })
  async registerInvoice(
    @Input() input: z.infer<typeof bridgeInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    return this.idempotency.run(input.idempotencyKey, async () => {
      const doc = await this.intake.detail(input.id)
      if (doc.status === 'dropped') {
        throw new ConflictException(
          'Dropped document cannot bridge to an invoice',
        )
      }
      const parsed = classifiedInvoiceSchema.safeParse(doc.classified)
      if (!parsed.success) {
        throw new ConflictException(
          `Classified payload is not an invoice: ${parsed.error.message}`,
        )
      }
      const { invoice, match } = await this.invoice.register(parsed.data)
      const invoiceId = (invoice as { id: string }).id
      const invoiceStatus = (invoice as { status: string }).status
      const bridged = await this.intake.attachInvoice(
        doc.id,
        invoiceId,
        invoiceStatus,
      )
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'intake.registerInvoice',
        entity: 'IntakeDocument',
        entityId: doc.id,
        input: { id: input.id, invoiceId },
        after: {
          doc: bridged.status,
          invoiceStatus,
          matchOutcome: match?.outcome,
        },
      })
      return { doc: bridged, invoice, match }
    })
  }
}
