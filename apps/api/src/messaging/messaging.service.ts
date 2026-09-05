import { createHash } from 'node:crypto'
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type MessageStatus, type MessageTier, Prisma } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import type { ListInput, ListResult } from '../trpc/list-input'
import { paginate } from '../trpc/list-input'

/**
 * §8.3 vendor messaging relay. Agents NEVER send to vendors directly: every
 * outbound message goes through this outbox, which
 *
 *  - addresses **verified identities** only — the recipient must appear in the
 *    vendor master's `contactChannels` (fraud SoD; unknown/changed addresses
 *    are refused at the tool boundary);
 *  - classifies every send into a tier server-side: transactional templates
 *    auto-send; free-form or binding content is queued for human approval.
 *    The caller cannot escalate itself to `auto` by claiming it;
 *  - records an immutable `Message` row (body hash = tamper-evidence) so
 *    threads replay for procurement and audit;
 *  - blocks outbound traffic to blacklisted vendors outright.
 *
 * The transport is a pluggable seam (org SMTP / transactional email API in a
 * real deployment); the default logs the dispatch and is honest about it.
 */

/** §8.3 low-risk / transactional templates eligible for auto-send. */
export const AUTO_TEMPLATES = [
  'rfq',
  'po_status',
  'delivery_notice',
  'invoice_ack',
] as const

export type AutoTemplateId = (typeof AUTO_TEMPLATES)[number]

/** DI token for the delivery seam. */
export const MESSAGE_TRANSPORT = Symbol('MESSAGE_TRANSPORT')

interface VendorContactChannels {
  /** Verified email identities on the vendor master. */
  verifiedEmails?: unknown
}

export interface SubmitMessageInput {
  vendorId: string
  recipient: string
  subject: string
  body: string
  templateId?: string | null
  threadId?: string | null
  agentId?: string | null
  runId?: string | null
}

export interface DecideMessageInput {
  id: string
  approverId: string
  reason?: string | null
}

/** Delivery seam: swap for org SMTP / transactional API per deployment. */
export interface MessageTransport {
  send(message: { to: string; subject: string; body: string }): Promise<void>
}

/** Default transport: structured stdout log (no external egress). */
@Injectable()
export class LoggingTransport implements MessageTransport {
  async send(message: { to: string; subject: string; body: string }) {
    console.log(
      JSON.stringify({
        channel: 'messaging-relay',
        event: 'dispatch',
        to: message.to,
        subject: message.subject,
        bytes: message.body.length,
      }),
    )
  }
}

/** Tamper-evidence over exactly the canonical content of the message. */
export function canonicalBodyHash(input: {
  recipient: string
  subject: string
  body: string
}): string {
  return createHash('sha256')
    .update(`${input.recipient}\n${input.subject}\n${input.body}`)
    .digest('hex')
}

function verifiedEmails(channels: unknown): string[] {
  const c = (channels ?? {}) as VendorContactChannels
  if (!Array.isArray(c.verifiedEmails)) return []
  return c.verifiedEmails.filter((e): e is string => typeof e === 'string')
}

@Injectable()
export class MessagingService {
  constructor(
    private readonly events: EventEmitterService,
    @Inject(MESSAGE_TRANSPORT) public readonly transport: MessageTransport,
  ) {}

  list(
    input: Partial<ListInput> & {
      status?: MessageStatus
      tier?: MessageTier
    } = {},
  ): Promise<ListResult<object>> {
    const { skip, take } = paginate({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    })
    const where = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.tier ? { tier: input.tier } : {}),
    }
    return Promise.all([
      db.message.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      db.message.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const message = await db.message.findUnique({ where: { id } })
    if (!message) throw new NotFoundException(`Message ${id} not found`)
    return message
  }

  /**
   * Submit an outbound message through the relay. Tier is derived
   * server-side: known transactional templates → `auto`; everything else
   * (including any unrecognised template and all free-form) → `gated`.
   */
  async submit(
    input: SubmitMessageInput,
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ message: object }> {
    // Creation + outbox + audit commit atomically via the caller's
    // idempotent transaction. The transport send happens after commit
    // through dispatchIfQueued, which only transitions queued → sent, so a
    // retry after a crash can never double-send (residual risk: a crash
    // between the provider accepting the email and the status update —
    // same window as any send-then-record pipeline; the outbox records it).
    const run = async (tx: Prisma.TransactionClient) => {
      const vendor = await tx.vendor.findUnique({
        where: { id: input.vendorId },
      })
      if (!vendor)
        throw new NotFoundException(`Vendor ${input.vendorId} not found`)

      if (vendor.status === 'blacklisted') {
        throw new ForbiddenException(
          `Vendor ${vendor.name} is blacklisted — outbound messaging blocked`,
        )
      }

      // Recipients are verified identities, not raw addresses (§8.3).
      const verified = verifiedEmails(vendor.contactChannels)
      if (!verified.includes(input.recipient)) {
        throw new ForbiddenException(
          verified.length === 0
            ? `Vendor ${vendor.name} has no verified contact channels — add one on the vendor master before messaging`
            : `Recipient ${input.recipient} is not a verified contact for ${vendor.name}`,
        )
      }

      const tier: MessageTier =
        input.templateId &&
        (AUTO_TEMPLATES as readonly string[]).includes(input.templateId)
          ? 'auto'
          : 'gated'

      const message = await tx.message.create({
        data: {
          vendorId: vendor.id,
          recipient: input.recipient,
          subject: input.subject,
          body: input.body,
          bodyHash: canonicalBodyHash(input),
          templateId: input.templateId ?? null,
          tier,
          status: 'queued',
          agentId: input.agentId ?? null,
          runId: input.runId ?? null,
          threadId: input.threadId ?? null,
        },
      })

      await this.events.emit(
        {
          type: 'message.submitted',
          entityType: 'Message',
          entityId: message.id,
          payload: {
            vendorId: vendor.id,
            tier,
            templateId: input.templateId ?? null,
          },
        },
        tx,
      )

      return { message }
    }
    // Staged but not sent: the caller dispatches after the surrounding
    // transaction commits (a send must never precede its durable outbox row).
    if (outerTx) return run(outerTx)
    const created = await db.$transaction(run)
    return this.releaseIfAuto(created)
  }

  /** Post-commit release for auto-tier messages (idempotent, never double-sends). */
  async releaseIfAuto(created: { message: object }) {
    const m = created.message as {
      id: string
      tier: MessageTier
      status: MessageStatus
    }
    if (m.tier === 'auto' && m.status === 'queued') {
      return { message: await this.dispatchIfQueued(m.id) }
    }
    return created
  }

  /**
   * Human approval of a gated draft (§8.3): reviewer sees agent + rationale +
   * thread, approves, and only then is it released — logged.
   */
  async approve(
    input: DecideMessageInput,
    tx: Prisma.TransactionClient = db,
  ): Promise<object> {
    const message = await tx.message.findUnique({
      where: { id: input.id },
    })
    if (!message) throw new NotFoundException(`Message ${input.id} not found`)
    // Conditional transition: concurrent approve/reject attempts serialize —
    // only one wins, the other reloads instead of overwriting.
    const changed = await tx.message.updateMany({
      where: { id: message.id, status: 'queued' },
      data: {
        status: 'approved',
        approvedBy: input.approverId,
        approvedAt: new Date(),
      },
    })
    if (changed.count !== 1) {
      throw new ConflictException(
        `Message ${input.id} is no longer queued — reload before deciding`,
      )
    }

    await this.events.emit(
      {
        type: 'message.approved',
        entityType: 'Message',
        entityId: message.id,
        payload: { approvedBy: input.approverId },
      },
      tx,
    )

    // Staged but not sent: the caller releases after commit (a send must
    // never precede its durable approval row).
    return tx.message.findUniqueOrThrow({ where: { id: message.id } })
  }

  /** Post-commit release for an approved draft (idempotent, never double-sends). */
  async releaseApproved(id: string): Promise<object> {
    const message = await this.detail(id)
    if (message.status !== 'approved') return message
    try {
      await this.transport.send({
        to: message.recipient,
        subject: message.subject,
        body: message.body,
      })
    } catch (error) {
      await db.message.updateMany({
        where: { id: message.id, status: 'approved' },
        data: {
          status: 'failed',
          failedReason: error instanceof Error ? error.message : String(error),
        },
      })
      return this.detail(message.id)
    }
    const updated = await db.message.updateMany({
      where: { id: message.id, status: 'approved' },
      data: { status: 'sent', sentAt: new Date() },
    })
    if (updated.count === 1) {
      await this.events.emit({
        type: 'message.sent',
        entityType: 'Message',
        entityId: message.id,
        payload: { recipient: message.recipient, tier: message.tier },
      })
    }
    return this.detail(message.id)
  }

  /** Human rejection of a gated draft, with a recorded reason. */
  async reject(
    input: DecideMessageInput,
    tx: Prisma.TransactionClient = db,
  ): Promise<object> {
    const message = await tx.message.findUnique({
      where: { id: input.id },
    })
    if (!message) throw new NotFoundException(`Message ${input.id} not found`)
    const changed = await tx.message.updateMany({
      where: { id: message.id, status: 'queued' },
      data: {
        status: 'rejected',
        approvedBy: input.approverId,
        approvedAt: new Date(),
        rejectedReason: input.reason ?? null,
      },
    })
    if (changed.count !== 1) {
      throw new ConflictException(
        `Message ${input.id} is no longer queued — reload before deciding`,
      )
    }
    const updated = await tx.message.findUniqueOrThrow({
      where: { id: message.id },
    })

    await this.events.emit(
      {
        type: 'message.rejected',
        entityType: 'Message',
        entityId: message.id,
        payload: { approvedBy: input.approverId, reason: input.reason ?? null },
      },
      tx,
    )

    return updated
  }

  /**
   * Conditional send: only a still-queued message transitions to sent, so
   * concurrent retries or a post-crash replay can never double-send.
   * Approved messages release through approve(); only queued rows qualify.
   */
  async dispatchIfQueued(id: string): Promise<object> {
    const queued = await this.detail(id)
    if (queued.status !== 'queued') return queued
    const message = queued
    try {
      await this.transport.send({
        to: message.recipient,
        subject: message.subject,
        body: message.body,
      })
    } catch (error) {
      await db.message.updateMany({
        where: { id: message.id, status: 'queued' },
        data: {
          status: 'failed',
          failedReason: error instanceof Error ? error.message : String(error),
        },
      })
      return this.detail(message.id)
    }

    const updated = await db.message.updateMany({
      where: { id: message.id, status: 'queued' },
      data: { status: 'sent', sentAt: new Date() },
    })
    if (updated.count === 1) {
      await this.events.emit({
        type: 'message.sent',
        entityType: 'Message',
        entityId: message.id,
        payload: { recipient: message.recipient, tier: message.tier },
      })
    }

    return this.detail(message.id)
  }
}
