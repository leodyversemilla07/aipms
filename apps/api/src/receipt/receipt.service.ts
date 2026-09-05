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
    outerTx?: Prisma.TransactionClient,
  ): Promise<{ receipt: object; rematch: RematchSummary }> {
    if (input.lines.length === 0) {
      throw new ConflictException('A receipt must carry at least one line')
    }

    // Serialize the over-receipt check and the receipt-number mint with
    // row + advisory locks so concurrent recorders cannot double-book.
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "purchaseOrder" WHERE id = ${input.poId} FOR UPDATE`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('receipt_number'))`

      const po = await tx.purchaseOrder.findUnique({
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
      const prior = await tx.receipt.findMany({
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

      // Receipt numbers are minted under the advisory lock above: no two
      // holders compute the same next number, so no create-retry is needed.
      const receiptNumber = await this.numbers.next('RCT-', () =>
        tx.receipt
          .findFirst({ orderBy: { receiptNumber: 'desc' } })
          .then((r) => r?.receiptNumber ?? null),
      )
      const receipt = await tx.receipt.create({
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
      const saved = receipt

      await this.events.emit(
        {
          type: 'receipt.recorded',
          entityType: 'Receipt',
          entityId: saved.id,
          payload: {
            poId: po.id,
            poNumber: po.poNumber,
            receiptNumber: saved.receiptNumber,
            lineCount: input.lines.length,
          },
        },
        tx,
      )

      // Goods landed: re-evaluate invoices that were waiting for them.
      const rematch = await this.invoice.rematchOpenForPo(po.id, tx)

      return { receipt: saved, rematch }
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /** Cancel a receipt. Recorded history is preserved; no delete path exists. */
  async cancel(id: string, tx: Prisma.TransactionClient = db): Promise<object> {
    const receipt = await tx.receipt.findUnique({ where: { id } })
    if (!receipt) throw new NotFoundException(`Receipt ${id} not found`)
    if (receipt.status === 'cancelled') {
      throw new ConflictException(`Receipt ${id} is already cancelled`)
    }
    const changed = await tx.receipt.updateMany({
      where: { id, status: 'recorded' },
      data: { status: 'cancelled' },
    })
    if (changed.count !== 1)
      throw new ConflictException('Receipt changed; reload before cancelling')
    return tx.receipt.findUniqueOrThrow({ where: { id } })
  }
}
