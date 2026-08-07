import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type IntakeStatus, Prisma } from '@workspace/db'

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
  async ingest(input: IngestInput) {
    try {
      return await db.intakeDocument.create({
        data: {
          channel: input.channel,
          contentHash: input.contentHash,
          senderId: input.senderId ?? null,
          raw: input.raw ?? undefined,
          status: 'new',
        },
      })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        // Duplicate by [channel, contentHash] — idempotent re-ingest.
        const existing = await db.intakeDocument.findUnique({
          where: {
            channel_contentHash: {
              channel: input.channel,
              contentHash: input.contentHash,
            },
          },
        })
        if (!existing) throw new ConflictException('Duplicate document')
        return existing
      }
      throw error
    }
  }

  async classify(input: ClassifyInput) {
    const doc = await this.detail(input.id)
    if (doc.status === 'dropped') {
      return this.requeue(input.id) // a dropped doc being re-classified wakes it
    }
    return db.intakeDocument.update({
      where: { id: input.id },
      data: {
        classified: input.classified as Prisma.InputJsonValue,
        status: 'extracted',
      },
    })
  }

  async requeue(id: string) {
    await this.detail(id)
    return db.intakeDocument.update({
      where: { id },
      data: { status: 'new', classified: Prisma.JsonNull },
    })
  }

  async drop(id: string) {
    await this.detail(id)
    return db.intakeDocument.update({
      where: { id },
      data: { status: 'dropped' },
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
