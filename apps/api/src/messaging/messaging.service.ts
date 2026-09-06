import { createHash } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, type MessageStatus, type MessageTier, Prisma } from '@workspace/db'
import { z } from 'zod'
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
 *  - classifies every send into a tier server-side and renders auto-tier
 *    content from server-owned templates plus validated data-only
 *    parameters: transactional templates auto-send; free-form or binding
 *    content is queued for human approval.
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

/**
 * §8.3 server-owned auto templates. `auto` tier content is rendered here from
 * validated data-only parameters — callers never supply free-form subject or
 * body for an allowlisted templateId, so a caller cannot smuggle binding
 * commercial language past human review by labelling it transactional.
 */
const AUTO_TEMPLATE_SCHEMAS = {
  rfq: z.object({
    sku: z.string().min(1).max(120),
    quantity: z.number().int().min(1).max(999_999),
  }),
  po_status: z.object({
    poNumber: z.string().min(1).max(60),
    status: z.enum(['issued', 'confirmed', 'cancelled']),
  }),
  delivery_notice: z.object({
    poNumber: z.string().min(1).max(60),
    quantity: z.number().int().min(1).max(999_999),
  }),
  invoice_ack: z.object({
    invoiceNumber: z.string().min(1).max(60),
  }),
} satisfies Record<AutoTemplateId, z.ZodType>

export type AutoTemplateParams = {
  [K in AutoTemplateId]: z.infer<(typeof AUTO_TEMPLATE_SCHEMAS)[K]>
}

export function renderAutoTemplate(
  templateId: AutoTemplateId,
  params: AutoTemplateParams[AutoTemplateId],
): { subject: string; body: string } {
  switch (templateId) {
    case 'rfq': {
      const p = params as AutoTemplateParams['rfq']
      return {
        subject: `Request for quotation: ${p.sku}`,
        body: `Please provide a quotation for ${p.quantity} unit(s) of ${p.sku}.`,
      }
    }
    case 'po_status': {
      const p = params as AutoTemplateParams['po_status']
      return {
        subject: `Purchase order ${p.poNumber}: ${p.status}`,
        body: `This is a status update for purchase order ${p.poNumber}. Current status: ${p.status}.`,
      }
    }
    case 'delivery_notice': {
      const p = params as AutoTemplateParams['delivery_notice']
      return {
        subject: `Delivery notice for ${p.poNumber}`,
        body: `Please expect delivery of ${p.quantity} unit(s) against purchase order ${p.poNumber}.`,
      }
    }
    case 'invoice_ack': {
      const p = params as AutoTemplateParams['invoice_ack']
      return {
        subject: `Invoice ${p.invoiceNumber} received`,
        body: `We received your invoice ${p.invoiceNumber}. It is queued for matching against the purchase order and goods receipts.`,
      }
    }
  }
}

/** DI token for the delivery seam. */
export const MESSAGE_TRANSPORT = Symbol('MESSAGE_TRANSPORT')

interface VendorContactChannels {
  /** Verified email identities on the vendor master. */
  verifiedEmails?: unknown
}

export interface SubmitMessageInput {
  vendorId: string
  recipient: string
  /** Free-form path only: required without an allowlisted templateId. */
  subject?: string
  body?: string
  /** Auto path only: allowlisted template + validated data-only params. */
  templateId?: string | null
  templateParams?: Record<string, unknown> | null
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
   * server-side and content for the auto tier is rendered server-side:
   *
   * - allowlisted `templateId` + valid `templateParams` (and NO caller
   *   subject/body) → `auto`, content from `renderAutoTemplate`;
   * - everything else (free-form, unrecognised template, or an allowlisted
   *   template used with caller-supplied prose/invalid params) → `gated`
   *   for free-form, or a 400 for a malformed auto request. The caller can
   *   never escalate its own prose to `auto` by claiming a template.
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

      let tier: MessageTier
      let rendered: { subject: string; body: string }
      if (
        input.templateId &&
        (AUTO_TEMPLATES as readonly string[]).includes(input.templateId)
      ) {
        const templateId = input.templateId as AutoTemplateId
        if (input.subject !== undefined || input.body !== undefined) {
          throw new BadRequestException(
            `subject/body must be omitted when templateId "${templateId}" is set — the server renders them from templateParams`,
          )
        }
        const parsed = AUTO_TEMPLATE_SCHEMAS[templateId].safeParse(
          input.templateParams ?? {},
        )
        if (!parsed.success) {
          throw new BadRequestException(
            `Invalid parameters for template "${templateId}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
          )
        }
        tier = 'auto'
        rendered = renderAutoTemplate(templateId, parsed.data)
      } else {
        if (!input.subject || !input.body) {
          throw new BadRequestException(
            'subject and body are required without a transactional templateId',
          )
        }
        tier = 'gated'
        rendered = { subject: input.subject, body: input.body }
      }

      const message = await tx.message.create({
        data: {
          vendorId: vendor.id,
          recipient: input.recipient,
          subject: rendered.subject,
          body: rendered.body,
          bodyHash: canonicalBodyHash({
            recipient: input.recipient,
            ...rendered,
          }),
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
