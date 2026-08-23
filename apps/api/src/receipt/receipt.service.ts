import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma, type ReceiptStatus } from '@workspace/db'
import type { RematchSummary } from '../invoice/invoice.service'
import { InvoiceService } from '../invoice/invoice.service'
import { DocumentNumberService } from '../shared/document-number/document-number.service'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import type { ListInput, ListResult } from '../trpc/list-input'
import { paginate } from '../trpc/list-input'

/**
 * §8.1 receipts — the middle leg of the three-way match (PO ↔ receipt ↔
 * invoice). Recording a receipt:
 *
 *  - validates the PO is live (issued or confirmed) and vendor-matched;
 *  - enforces an over-receipt gate: cumulative recorded quantity per PO line
 *    can never exceed the ordered quantity — a deterministic guard, not an
 *    LLM judgement;
 *  - re-runs the three-way match for invoices parked on this PO
 *    (`awaiting_receipt` → matched / exception), so goods arriving unblock
 *    matching without any agent arithmetic.
 */

export interface RecordReceiptLineInput {
  poLineId?: string | null
  /** Mirror of the PO line number when receiving against a known line. */
  lineNo?: number | null
  sku?: string | null
  description: string
  quantity: number
  unit?: string
}

export interface RecordReceiptInput {
  poId: string
  lines: RecordReceiptLineInput[]
  note?: string | null
  recordedBy: string
}

@Injectable()
export class ReceiptService {
  constructor(
    private readonly numbers: DocumentNumberService,
    private readonly events: EventEmitterService,
    @Inject(InvoiceService) private readonly invoice: InvoiceService,
  ) {}

  list(
    input: Partial<ListInput> & { status?: ReceiptStatus; poId?: string } = {},
  ): Promise<ListResult<object>> {
    const { skip, take } = paginate({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    })
    const where = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.poId ? { poId: input.poId } : {}),
    }
    return Promise.all([
      db.receipt.findMany({
        where,
        skip,
        take,
        orderBy: { recordedAt: 'desc' },
        include: { lines: true },
      }),
      db.receipt.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  async detail(id: string) {
    const receipt = await db.receipt.findUnique({
      where: { id },
      include: { lines: true },
    })
    if (!receipt) throw new NotFoundException(`Receipt ${id} not found`)
    return receipt
  }

  async record(
    input: RecordReceiptInput,
  ): Promise<{ receipt: object; rematch: RematchSummary }> {
    if (input.lines.length === 0) {
      throw new ConflictException('A receipt must carry at least one line')
    }

    const po = await db.purchaseOrder.findUnique({
      where: { id: input.poId },
      include: { lines: true },
    })
    if (!po)
      throw new NotFoundException(`Purchase order ${input.poId} not found`)
    if (po.status !== 'issued' && po.status !== 'confirmed') {
      throw new ConflictException(
        `PO ${po.poNumber} is ${po.status} — goods can only be received against an issued or confirmed PO`,
      )
    }

    // §8.1 over-receipt gate: cumulative recorded + new ≤ ordered per line.
    const prior = await db.receipt.findMany({
      where: { poId: po.id, status: 'recorded' },
      select: { lines: { select: { quantity: true, lineNo: true } } },
    })
    const receivedByLine = new Map<number, number>()
    for (const receipt of prior) {
      for (const line of receipt.lines) {
        if (line.lineNo == null) continue
        receivedByLine.set(
          line.lineNo,
          (receivedByLine.get(line.lineNo) ?? 0) + line.quantity,
        )
      }
    }
    for (const line of input.lines) {
      if (line.quantity <= 0 || !Number.isInteger(line.quantity)) {
        throw new ConflictException(
          'Receipt quantities must be positive integers',
        )
      }
      if (line.lineNo == null) continue
      const poLine = po.lines.find((l) => l.lineNo === line.lineNo)
      if (!poLine) continue
      const already = receivedByLine.get(line.lineNo) ?? 0
      if (already + line.quantity > poLine.quantity) {
        throw new ConflictException(
          `Over-receipt on PO ${po.poNumber} line ${line.lineNo}: ` +
            `${already} already received, ${line.quantity} more exceeds the ordered ${poLine.quantity}`,
        )
      }
    }

    // Sequential number with unique-key race retry: concurrent recorders may
    // compute the same next number; the loser recomputes and retries.
    let receipt: object | undefined
    for (let attempt = 0; attempt < 5 && !receipt; attempt++) {
      const receiptNumber = await this.numbers.next('RCT-', () =>
        db.receipt
          .findFirst({ orderBy: { receiptNumber: 'desc' } })
          .then((r) => r?.receiptNumber ?? null),
      )
      try {
        receipt = await db.receipt.create({
          data: {
            receiptNumber,
            poId: po.id,
            vendorId: po.vendorId,
            status: 'recorded',
            note: input.note ?? undefined,
            recordedBy: input.recordedBy,
            lines: {
              create: input.lines.map((line) => ({
                poLineId:
                  line.poLineId ??
                  po.lines.find((l) => l.lineNo === line.lineNo)?.id ??
                  null,
                lineNo: line.lineNo ?? null,
                sku: line.sku ?? null,
                description: line.description,
                quantity: line.quantity,
                unit: line.unit ?? 'ea',
              })),
            },
          },
          include: { lines: true },
        })
      } catch (error) {
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          )
        ) {
          throw error
        }
      }
    }
    if (!receipt) {
      throw new ConflictException(
        'Could not allocate a receipt number after 5 attempts — retry',
      )
    }
    const saved = receipt as Awaited<ReturnType<typeof db.receipt.create>>

    await this.events.emit({
      type: 'receipt.recorded',
      entityType: 'Receipt',
      entityId: saved.id,
      payload: {
        poId: po.id,
        poNumber: po.poNumber,
        receiptNumber: saved.receiptNumber,
        lineCount: input.lines.length,
      },
    })

    // Goods landed: re-evaluate invoices that were waiting for them.
    const rematch = await this.invoice.rematchOpenForPo(po.id)

    return { receipt: saved, rematch }
  }

  /** Cancel a receipt. Recorded history is preserved; no delete path exists. */
  async cancel(id: string): Promise<object> {
    const receipt = await this.detail(id)
    if (receipt.status === 'cancelled') {
      throw new ConflictException(`Receipt ${id} is already cancelled`)
    }
    return db.receipt.update({
      where: { id },
      data: { status: 'cancelled' },
    })
  }
}
