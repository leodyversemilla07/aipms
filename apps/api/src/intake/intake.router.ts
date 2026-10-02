import { createHash } from 'node:crypto'
import { ConflictException, Inject, NotFoundException } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { invoicePayloadSchema } from '../agent/invoice-payload'
import { InvoiceService } from '../invoice/invoice.service'
import { AuditService } from '../shared/audit/audit.service'
import { IdempotencyService } from '../shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { IntakeService } from './intake.service'
import { projectIntakeDocumentForAgent } from './intake-agent-projection'
import { IntakeCommandService } from './intake-command.service'
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
  idempotencyKey: z.string().min(1),
  classified: invoicePayloadSchema,
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
const commandInput = idInput.extend({ idempotencyKey: z.string().min(1) })

const bridgeInput = commandInput

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
    @Inject(IntakeCommandService)
    private readonly commands: IntakeCommandService,
    @Inject(InvoiceService) private readonly invoice: InvoiceService,
    @Inject(IdempotencyService)
    private readonly idempotency: IdempotencyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Query({ input: listInputWithStatus })
  async list(
    @Input() input: z.infer<typeof listInputWithStatus>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const documents = await this.intake.list(input)
    return documents.map((document) => this.projectDocument(document, ctx))
  }

  @Query({ input: idInput })
  async detail(
    @Input() input: z.infer<typeof idInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const document = await this.intake.detail(input.id)
    return this.projectDocument(document, ctx)
  }

  @Mutation({ input: ingestInput })
  async ingest(
    @Input() input: z.infer<typeof ingestInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const document = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.ingest',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const { idempotencyKey, ...ingestInput } = input
        const rawScopes = (ctx.user as { scopes?: unknown }).scopes
        return this.commands.ingest(
          ingestInput,
          {
            id: ctx.user.id,
            kind: ctx.actorKind,
            role: ctx.user.role,
            scopes: Array.isArray(rawScopes)
              ? rawScopes.filter(
                  (scope): scope is string => typeof scope === 'string',
                )
              : undefined,
            source: 'trpc',
            runId: (ctx.user as { runId?: string }).runId,
            idempotencyKey,
          },
          tx,
        )
      },
    )
    return this.projectDocument(document, ctx)
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
    const document = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.ingestStructured',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const classified = parseStructuredInvoice(input.channel, input.content)
        const contentHash = createHash('sha256')
          .update(input.content)
          .digest('hex')
        const doc = await this.intake.ingest(
          {
            channel: input.channel,
            contentHash,
            senderId: input.senderId ?? null,
            raw: input.content.length <= 262144 ? input.content : undefined,
          },
          tx,
        )
        const extracted = await this.intake.classify(
          { id: doc.id, classified },
          tx,
        )
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'intake.ingestStructured',
            entity: 'IntakeDocument',
            entityId: doc.id,
            input: { channel: input.channel, contentHash },
            after: { status: extracted.status },
          },
          tx,
        )
        return extracted
      },
    )
    return this.projectDocument(document, ctx)
  }

  @Mutation({ input: classifyInput })
  async classify(
    @Input() input: z.infer<typeof classifyInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const document = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.classify',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const doc = await this.intake.classify(
          { id: input.id, classified: input.classified },
          tx,
        )
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'intake.classify',
            entity: 'IntakeDocument',
            entityId: doc.id,
            input,
            after: doc,
          },
          tx,
        )
        return doc
      },
    )
    return this.projectDocument(document, ctx)
  }

  @Mutation({ input: commandInput })
  async drop(
    @Input() input: z.infer<typeof commandInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const document = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.drop',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const doc = await this.intake.drop(input.id, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'intake.drop',
            entity: 'IntakeDocument',
            entityId: doc.id,
            input,
          },
          tx,
        )
        return doc
      },
    )
    return this.projectDocument(document, ctx)
  }

  @Mutation({ input: commandInput })
  async requeue(
    @Input() input: z.infer<typeof commandInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    const document = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.requeue',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const doc = await this.intake.requeue(input.id, tx)
        await this.audit.record(
          {
            actorId: ctx.user.id,
            actorKind: ctx.actorKind,
            action: 'intake.requeue',
            entity: 'IntakeDocument',
            entityId: doc.id,
            input,
          },
          tx,
        )
        return doc
      },
    )
    return this.projectDocument(document, ctx)
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
    const result = await this.idempotency.runAtomic(
      {
        actorId: ctx.user.id,
        operation: 'intake.registerInvoice',
        key: input.idempotencyKey,
        input,
      },
      async (tx) => {
        const doc = await tx.intakeDocument.findUnique({
          where: { id: input.id },
        })
        if (!doc) throw new NotFoundException(`Intake ${input.id} not found`)
        if (doc.status === 'dropped') {
          throw new ConflictException(
            'Dropped document cannot bridge to an invoice',
          )
        }
        const parsed = invoicePayloadSchema.safeParse(doc.classified)
        if (!parsed.success) {
          throw new ConflictException(
            `Classified payload is not an invoice: ${parsed.error.message}`,
          )
        }
        const { invoice, match } = await this.invoice.register(parsed.data, tx)
        const invoiceId = (invoice as { id: string }).id
        const invoiceStatus = (invoice as { status: string }).status
        const bridged = await this.intake.attachInvoice(
          doc.id,
          invoiceId,
          invoiceStatus,
          tx,
        )
        await this.audit.record(
          {
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
          },
          tx,
        )
        return { doc: bridged, invoice, match }
      },
    )
    return {
      ...result,
      doc: this.projectDocument(result.doc, ctx),
    }
  }

  /** Project after idempotency so cached raw outcomes cannot bypass redaction. */
  private projectDocument<T extends { raw: unknown; classified: unknown }>(
    document: T,
    ctx: AuthedTrpcContext,
  ) {
    return ctx.actorKind === 'agent'
      ? projectIntakeDocumentForAgent(document)
      : document
  }
}
