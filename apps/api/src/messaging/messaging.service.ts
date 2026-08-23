import { createHash } from 'node:crypto'
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type MessageStatus, type MessageTier } from '@workspace/db'
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
  async submit(input: SubmitMessageInput): Promise<{ message: object }> {
    const vendor = await db.vendor.findUnique({
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

    let message = await db.message.create({
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

    await this.events.emit({
      type: 'message.submitted',
      entityType: 'Message',
      entityId: message.id,
      payload: {
        vendorId: vendor.id,
        tier,
        templateId: input.templateId ?? null,
      },
    })

    // Low-risk transactional content releases immediately; gated waits.
    if (tier === 'auto') {
      message = (await this.dispatch(message.id)) as typeof message
    }

    return { message }
  }

  /**
   * Human approval of a gated draft (§8.3): reviewer sees agent + rationale +
   * thread, approves, and only then is it released — logged.
   */
  async approve(input: DecideMessageInput): Promise<object> {
    const message = await this.detail(input.id)
    if (message.status !== 'queued') {
      throw new ConflictException(
        `Message ${input.id} is ${message.status}, only queued drafts can be approved`,
      )
    }

    await db.message.update({
      where: { id: message.id },
      data: {
        status: 'approved',
        approvedBy: input.approverId,
        approvedAt: new Date(),
      },
    })

    await this.events.emit({
      type: 'message.approved',
      entityType: 'Message',
      entityId: message.id,
      payload: { approvedBy: input.approverId },
    })

    return this.dispatch(message.id)
  }

  /** Human rejection of a gated draft, with a recorded reason. */
  async reject(input: DecideMessageInput): Promise<object> {
    const message = await this.detail(input.id)
    if (message.status !== 'queued') {
      throw new ConflictException(
        `Message ${input.id} is ${message.status}, only queued drafts can be rejected`,
      )
    }

    const updated = await db.message.update({
      where: { id: message.id },
      data: {
        status: 'rejected',
        approvedBy: input.approverId,
        approvedAt: new Date(),
        rejectedReason: input.reason ?? null,
      },
    })

    await this.events.emit({
      type: 'message.rejected',
      entityType: 'Message',
      entityId: message.id,
      payload: { approvedBy: input.approverId, reason: input.reason ?? null },
    })

    return updated
  }

  /** Release a queued/approved message through the transport seam. */
  private async dispatch(id: string): Promise<object> {
    const message = await this.detail(id)
    try {
      await this.transport.send({
        to: message.recipient,
        subject: message.subject,
        body: message.body,
      })
    } catch (error) {
      return db.message.update({
        where: { id: message.id },
        data: {
          status: 'failed',
          failedReason: error instanceof Error ? error.message : String(error),
        },
      })
    }

    const sent = await db.message.update({
      where: { id: message.id },
      data: { status: 'sent', sentAt: new Date() },
    })

    await this.events.emit({
      type: 'message.sent',
      entityType: 'Message',
      entityId: message.id,
      payload: { recipient: sent.recipient, tier: sent.tier },
    })

    return sent
  }
}
