import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type IntakeStatus, Prisma } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'

export interface IngestInput {
  channel: string // EMAIL_IMAP | EINVOICE_EIS | PEPPOL | EDI | API | PORTAL
  contentHash: string
  senderId?: string | null
  raw?: unknown
}

export interface ClassifyInput {
  id: string
  /** extraction: document type, vendor hint/amounts — filled by extractor/agent */
  classified: unknown
}

/**
 * §8.2 normalized ingestion queue. Documents enter here from any channel
 * (email, structured e-invoice XML/JSON, Peppol/EDI, API) and are deduped on
 * [channel, contentHash] — re-ingest returns the existing row. Downstream the
 * agent extracts a classified payload and InvoiceService registers it.
 */
@Injectable()
export class IntakeService {
  constructor(private readonly events: EventEmitterService) {}
  async ingest(input: IngestInput, outerTx?: Prisma.TransactionClient) {
    // Dedupe up front: a unique violation would abort an outer transaction.
    // A concurrent insert racing the pre-check surfaces as P2002; the caller
    // retries the idempotency key and the pre-check returns the winner.
    const client = outerTx ?? db
    const duplicate = await client.intakeDocument.findUnique({
      where: {
        channel_contentHash: {
          channel: input.channel,
          contentHash: input.contentHash,
        },
      },
    })
    if (duplicate) return duplicate
    const doc = await client.intakeDocument.create({
      data: {
        channel: input.channel,
        contentHash: input.contentHash,
        senderId: input.senderId ?? null,
        raw: input.raw ?? undefined,
        status: 'new',
      },
    })
    await this.events.emit(
      {
        type: 'intake.received',
        entityType: 'IntakeDocument',
        entityId: doc.id,
        payload: { channel: doc.channel, contentHash: doc.contentHash },
      },
      outerTx,
    )
    return doc
  }

  async classify(input: ClassifyInput, tx: Prisma.TransactionClient = db) {
    const doc = await tx.intakeDocument.findUnique({
      where: { id: input.id },
    })
    if (!doc) throw new NotFoundException(`Intake ${input.id} not found`)
    if (doc.status === 'dropped') {
      return this.requeue(input.id, tx) // a dropped doc being re-classified wakes it
    }
    return tx.intakeDocument.update({
      where: { id: input.id },
      data: {
        classified: input.classified as Prisma.InputJsonValue,
        status: 'extracted',
      },
    })
  }

  async requeue(id: string, tx: Prisma.TransactionClient = db) {
    const doc = await tx.intakeDocument.findUnique({ where: { id } })
    if (!doc) throw new NotFoundException(`Intake ${id} not found`)
    return tx.intakeDocument.update({
      where: { id },
      data: { status: 'new', classified: Prisma.JsonNull },
    })
  }

  async drop(id: string, tx: Prisma.TransactionClient = db) {
    const doc = await tx.intakeDocument.findUnique({ where: { id } })
    if (!doc) throw new NotFoundException(`Intake ${id} not found`)
    return tx.intakeDocument.update({
      where: { id },
      data: { status: 'dropped' },
    })
  }

  /**
   * §9 bridge result — a classified document that an extractor/agent
   * turned into a registered invoice records the invoice id + status, and the
   * document progresses from extracted to matched (or exception) accordingly.
   */
  async attachInvoice(
    id: string,
    invoiceId: string,
    invoiceStatus: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const doc = await tx.intakeDocument.findUnique({ where: { id } })
    if (!doc) throw new NotFoundException(`Intake ${id} not found`)
    if (doc.status === 'dropped') {
      throw new ConflictException(
        'Dropped document cannot bridge to an invoice',
      )
    }
    const nextStatus: IntakeStatus =
      invoiceStatus === 'matched'
        ? 'matched'
        : invoiceStatus === 'exception'
          ? 'exception'
          : 'extracted'
    const prev =
      doc.classified &&
      typeof doc.classified === 'object' &&
      !Array.isArray(doc.classified)
        ? (doc.classified as Record<string, unknown>)
        : {}
    return tx.intakeDocument.update({
      where: { id },
      data: {
        status: nextStatus,
        classified: {
          ...prev,
          invoiceId,
          invoiceStatus,
        } as Prisma.InputJsonValue,
      },
    })
  }

  list(where: { status?: IntakeStatus } = {}) {
    return db.intakeDocument.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
    })
  }

  async detail(id: string) {
    const doc = await db.intakeDocument.findUnique({ where: { id } })
    if (!doc) throw new NotFoundException(`IntakeDocument ${id} not found`)
    return doc
  }
}
