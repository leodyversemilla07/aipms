import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'

/**
 * §8.1/§7.5 structured quoting — the SOURCING → QUOTED leg of the lifecycle.
 * RFQs ride the §8.3 messaging relay; offers arrive through any intake
 * channel and are recorded here as first-class Quote rows. Award is a pure,
 * deterministic decision over received offers — never an agent's vibes:
 *
 * - `lowestCost` (default): rank by totalMinor ascending.
 * - `bestValue`: score = priceWeight × price-rank-component +
 *   (1 − priceWeight) × ratingScore component, both normalized to [0,100].
 *   The criterion and weight come from the instance's evaluationCriterion
 *   policy (§16.1 configuration-over-fork); absent policy ⇒ lowestCost.
 *
 * Award is exclusive per requisition: accepting one quote rejects its
 * siblings with a reason, in one transaction, audited.
 */

export interface QuoteLineInput {
  sku?: string
  description: string
  quantity?: number
  unitPriceMinor?: number
  amountMinor: number
}

export interface ReceiveQuoteInput {
  totalMinor: number
  currencyCode?: string
  leadTimeDays?: number
  validUntil?: Date
  lines?: QuoteLineInput[]
  payload?: unknown
}

/** evaluationCriterion policy config (§16.1 seam). */
interface EvaluationConfig {
  criterion?: 'lowestCost' | 'bestValue'
  priceWeight?: number // 0..1, bestValue only (default 0.6)
}

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue

@Injectable()
export class SourcingService {
  constructor(private readonly events: EventEmitterService) {}

  /**
   * Open an RFQ against one requisition per vendor. Idempotent per pair —
   * re-requesting an existing vendor quote returns the existing row.
   */
  async request(
    requisitionId: string,
    vendorIds: string[],
    requestedBy: string,
    outerTx?: Prisma.TransactionClient,
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      // Serialize per requisition: the [requisitionId, vendorId] pair is
      // unique, and a violation would abort the transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sourcing:${requisitionId}`}))`
      const requisition = await tx.requisition.findUnique({
        where: { id: requisitionId },
      })
      if (!requisition) {
        throw new NotFoundException(`Requisition ${requisitionId} not found`)
      }
      if (requisition.status !== 'approved') {
        throw new ConflictException(
          `Requisition ${requisition.requestNumber} is ${requisition.status} — only approved requisitions source quotes`,
        )
      }

      const vendors = await tx.vendor.findMany({
        where: { id: { in: [...new Set(vendorIds)] } },
      })
      if (vendors.length !== new Set(vendorIds).size) {
        throw new NotFoundException('One or more vendors do not exist')
      }

      const quotes: Awaited<ReturnType<typeof tx.quote.create>>[] = []
      for (const vendor of vendors) {
        const existing = await tx.quote.findUnique({
          where: {
            requisitionId_vendorId: { requisitionId, vendorId: vendor.id },
          },
        })
        if (existing) {
          quotes.push(existing)
          continue
        }
        quotes.push(
          await tx.quote.create({
            data: {
              requisitionId,
              vendorId: vendor.id,
              requestedBy,
              createdBy: requestedBy,
            },
          }),
        )
      }
      return quotes
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /** Record one structured offer against a requested quote. */
  async receive(
    quoteId: string,
    input: ReceiveQuoteInput,
    tx: Prisma.TransactionClient = db,
  ) {
    const quote = await tx.quote.findUnique({ where: { id: quoteId } })
    if (!quote) throw new NotFoundException(`Quote ${quoteId} not found`)
    if (!Number.isSafeInteger(input.totalMinor) || input.totalMinor <= 0) {
      throw new BadRequestException('totalMinor must be a positive integer')
    }
    // Conditional write: an awarded/rejected quote must never be overwritten
    // by a late offer, even under concurrent receive + award.
    const changed = await tx.quote.updateMany({
      where: { id: quoteId, status: { in: ['requested', 'received'] } },
      data: {
        status: 'received',
        totalMinor: input.totalMinor,
        currencyCode: input.currencyCode ?? quote.currencyCode,
        leadTimeDays: input.leadTimeDays,
        validUntil: input.validUntil,
        lines: input.lines ? asJson(input.lines) : undefined,
        payload: input.payload != null ? asJson(input.payload) : undefined,
      },
    })
    if (changed.count !== 1) {
      throw new ConflictException(
        `Quote is no longer open for offers — reload before recording`,
      )
    }
    return tx.quote.findUniqueOrThrow({ where: { id: quoteId } })
  }

  /**
   * Deterministic comparison of all received quotes for a requisition.
   * Pure ranking — no side effects — so humans review before award.
   */
  async compare(requisitionId: string) {
    await this.assertRequisition(requisitionId)
    const quotes = await db.quote.findMany({
      where: { requisitionId, status: 'received' },
    })

    const config = await this.evaluationCriterion()
    const ranked = [...quotes].sort((a, b) => {
      if ((a.totalMinor ?? Infinity) !== (b.totalMinor ?? Infinity)) {
        return (a.totalMinor ?? Infinity) - (b.totalMinor ?? Infinity)
      }
      return a.id.localeCompare(b.id) // stable tie-break
    })

    let scores: Array<{ quoteId: string; score: number }> | null = null
    if (config.criterion === 'bestValue') {
      const weight =
        config.priceWeight != null &&
        Number.isFinite(config.priceWeight) &&
        config.priceWeight >= 0 &&
        config.priceWeight <= 1
          ? config.priceWeight
          : 0.6
      const totals = ranked.map((q) => q.totalMinor ?? 0)
      const maxTotal = Math.max(...totals, 1)
      scores = ranked.map((q) => {
        const priceComponent =
          (q.totalMinor == null ? 0 : (maxTotal - q.totalMinor) / maxTotal) *
          100
        const ratingComponent = 50 // vendor.ratingScore seam: neutral until populated
        return {
          quoteId: q.id,
          score: Math.round(
            weight * priceComponent + (1 - weight) * ratingComponent,
          ),
        }
      })
      scores.sort(
        (a, b) => b.score - a.score || a.quoteId.localeCompare(b.quoteId),
      )
    }

    return {
      criterion: config.criterion ?? 'lowestCost',
      priceWeight:
        config.criterion === 'bestValue' ? (config.priceWeight ?? 0.6) : null,
      recommendedQuoteId: ranked[0]?.id ?? scores?.[0]?.quoteId ?? null,
      ranking:
        config.criterion === 'bestValue'
          ? (scores ?? []).map((s) => ({ quoteId: s.quoteId, score: s.score }))
          : ranked.map((q) => ({ quoteId: q.id, score: null })),
    }
  }

  /** Exclusive award: accept one quote, reject siblings, emit + audit-ready. */
  async award(
    quoteId: string,
    awardedBy: string,
    outerTx?: Prisma.TransactionClient,
  ) {
    const quote = await this.detail(quoteId)
    if (quote.totalMinor == null) {
      throw new BadRequestException('Quote has no recorded offer amount')
    }

    const criterion =
      (await this.evaluationCriterion()).criterion ?? 'lowestCost'

    const run = async (tx: Prisma.TransactionClient) => {
      // Serialize awards per requisition: without this lock two concurrent
      // awards for sibling quotes could both accept (exclusivity violated).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`award:${quote.requisitionId}`}))`
      const current = await tx.quote.findUnique({ where: { id: quoteId } })
      if (!current) throw new NotFoundException(`Quote ${quoteId} not found`)
      if (current.status !== 'received') {
        throw new ConflictException(
          `Quote is ${current.status} — only received quotes can be awarded`,
        )
      }
      const alreadyAccepted = await tx.quote.count({
        where: { requisitionId: current.requisitionId, status: 'accepted' },
      })
      if (alreadyAccepted > 0) {
        throw new ConflictException('Requisition already has an accepted quote')
      }
      await tx.quote.updateMany({
        where: {
          requisitionId: current.requisitionId,
          status: 'received',
          id: { not: quoteId },
        },
        data: { status: 'rejected', rejectedReason: 'not selected at award' },
      })
      const accepted = await tx.quote.updateMany({
        where: { id: quoteId, status: 'received' },
        data: { status: 'accepted', awardedAt: new Date() },
      })
      if (accepted.count !== 1) {
        throw new ConflictException('Quote changed during award; retry')
      }
      const awarded = await tx.quote.findUniqueOrThrow({
        where: { id: quoteId },
      })
      await this.events.emit(
        {
          type: 'quote.awarded',
          entityType: 'Quote',
          entityId: quoteId,
          payload: {
            requisitionId: current.requisitionId,
            vendorId: current.vendorId,
            totalMinor: current.totalMinor,
            criterion,
            awardedBy,
          },
        },
        tx,
      )
      return awarded
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  list(
    where: {
      requisitionId?: string
      status?: 'requested' | 'received' | 'accepted' | 'rejected'
    } = {},
  ) {
    return db.quote.findMany({ where, orderBy: { createdAt: 'desc' } })
  }

  async detail(id: string) {
    const quote = await db.quote.findUnique({ where: { id } })
    if (!quote) throw new NotFoundException(`Quote ${id} not found`)
    return quote
  }

  private async assertRequisition(requisitionId: string) {
    const requisition = await db.requisition.findUnique({
      where: { id: requisitionId },
    })
    if (!requisition) {
      throw new NotFoundException(`Requisition ${requisitionId} not found`)
    }
    return requisition
  }

  /** Latest enabled evaluationCriterion policy, or default lowestCost. */
  private async evaluationCriterion(): Promise<EvaluationConfig> {
    const policy = await db.policy.findFirst({
      where: { kind: 'evaluationCriterion', enabled: true },
      orderBy: [{ updatedAt: 'desc' }, { version: 'desc' }],
    })
    return asRecord(policy)
  }
}

function asRecord(policy: unknown): EvaluationConfig {
  const p = policy as { config?: unknown } | null
  const cfg = (p?.config ?? {}) as Partial<EvaluationConfig>
  return {
    criterion:
      cfg.criterion === 'bestValue'
        ? 'bestValue'
        : cfg.criterion === 'lowestCost'
          ? 'lowestCost'
          : undefined,
    priceWeight:
      typeof cfg.priceWeight === 'number' ? cfg.priceWeight : undefined,
  }
}
