import { Injectable } from '@nestjs/common'
import { db, type Prisma, type UserKind, type UserRole } from '@workspace/db'
import { AuditService } from '../shared/audit/audit.service'
import {
  assertAgentCapability,
  resolveAgentScopes,
} from '../trpc/agent-capabilities'
import { assertHumanProcedureRole } from '../trpc/authorize'
import { type IngestInput, IntakeService } from './intake.service'

export interface IntakeCommandActor {
  id: string
  kind: UserKind
  role?: UserRole
  scopes?: readonly string[]
  source: 'trpc' | 'imap'
  idempotencyKey?: string
}

/** Shared authorization/audit boundary for interactive and IMAP ingestion. */
@Injectable()
export class IntakeCommandService {
  constructor(
    private readonly intake: IntakeService,
    private readonly audit: AuditService,
  ) {}

  async ingest(
    input: IngestInput,
    actor: IntakeCommandActor,
    outerTx?: Prisma.TransactionClient,
  ) {
    await this.authorize(actor)
    const run = async (tx: Prisma.TransactionClient) => {
      const doc = await this.intake.ingest(input, tx)
      await this.audit.record(
        {
          actorId: actor.id,
          actorKind: actor.kind,
          action: 'intake.ingest',
          entity: 'IntakeDocument',
          entityId: doc.id,
          input: {
            ...input,
            source: actor.source,
            idempotencyKey: actor.idempotencyKey,
          },
          after: { status: doc.status, channel: doc.channel },
        },
        tx,
      )
      return doc
    }
    if (outerTx) return run(outerTx)
    try {
      return await db.$transaction(run)
    } catch (error) {
      await this.audit.record({
        actorId: actor.id,
        actorKind: actor.kind,
        action: 'intake.ingest.failed',
        entity: 'IntakeDocument',
        entityId: null,
        input: {
          channel: input.channel,
          contentHash: input.contentHash,
          source: actor.source,
          idempotencyKey: actor.idempotencyKey,
        },
        after: { error: this.errorMessage(error) },
      })
      throw error
    }
  }

  private async authorize(actor: IntakeCommandActor) {
    try {
      if (actor.kind === 'agent') {
        assertAgentCapability(
          'intake.ingest',
          actor.scopes ?? resolveAgentScopes(process.env),
        )
      } else {
        assertHumanProcedureRole('intake.ingest', actor.role ?? 'user')
      }
    } catch (error) {
      await this.audit.record({
        actorId: actor.id,
        actorKind: actor.kind,
        action: 'intake.ingest.denied',
        entity: 'Authorization',
        entityId: 'intake.ingest',
        input: {
          source: actor.source,
          idempotencyKey: actor.idempotencyKey,
        },
        after: { error: this.errorMessage(error) },
      })
      throw error
    }
  }

  private errorMessage(error: unknown) {
    return error instanceof Error
      ? error.message.slice(0, 500)
      : 'Unknown error'
  }
}
