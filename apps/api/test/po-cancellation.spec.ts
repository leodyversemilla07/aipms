import { randomUUID } from 'node:crypto'
import { ConflictException } from '@nestjs/common'
import { db, type Prisma } from '@workspace/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApprovalService } from '../src/approval/approval.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentRunService } from '../src/payment-run/payment-run.service'
import { PolicyService } from '../src/policy/policy.service'
import { ReceiptService } from '../src/receipt/receipt.service'
import { DocumentNumberService } from '../src/shared/document-number/document-number.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { VendorService } from '../src/vendor/vendor.service'

/** Real PostgreSQL transactions/locks; the standard *_test guard is mandatory. */
const prefix = `cancel-${randomUUID()}`
const maker = `${prefix}-maker`
const checker = `${prefix}-checker`
const created = {
  budget: [] as string[],
  requisition: [] as string[],
  po: [] as string[],
  invoice: [] as string[],
  receipt: [] as string[],
  approval: [] as string[],
  run: [] as string[],
}
const events = new EventEmitterService()
const invoices = new InvoiceService(new PolicyService(), events)
const approvals = new ApprovalService(events, invoices)
const numbers = new DocumentNumberService()
const runs = new PaymentRunService(numbers)
const receipts = new ReceiptService(numbers, events, invoices)
let vendorId: string | undefined

beforeAll(async () => {
  await db.user.createMany({
    data: [maker, checker].map((id) => ({
      id,
      name: id,
      email: `${id}@test.aipms`,
      role: 'finance',
    })),
  })
  const vendor = await db.vendor.create({
    data: { name: prefix, status: 'active' },
  })
  vendorId = vendor.id
  const vendors = new VendorService()
  const account = { bank: 'BPI', holder: prefix, accountNo: '1234567890' }
  await vendors.verifyBankAccount(vendor.id, account, maker)
  await vendors.verifyBankAccount(vendor.id, account, checker)
})

afterAll(async () => {
  await db.domainEvent.deleteMany({
    where: { entityId: { in: Object.values(created).flat() } },
  })
  await db.paymentRun.deleteMany({ where: { id: { in: created.run } } })
  await db.approval.deleteMany({ where: { id: { in: created.approval } } })
  await db.invoice.deleteMany({ where: { id: { in: created.invoice } } })
  await db.receipt.deleteMany({ where: { id: { in: created.receipt } } })
  await db.purchaseOrder.deleteMany({ where: { id: { in: created.po } } })
  await db.requisition.deleteMany({
    where: { id: { in: created.requisition } },
  })
  await db.budget.deleteMany({ where: { id: { in: created.budget } } })
  if (vendorId) await db.vendor.delete({ where: { id: vendorId } })
  await db.user.deleteMany({ where: { id: { in: [maker, checker] } } })
  await db.$disconnect()
})

async function fixture(withReceipt = false) {
  if (!vendorId) throw new Error('Fixture vendor missing')
  const tag = randomUUID()
  const budget = await db.budget.create({
    data: {
      name: prefix,
      costCenter: tag,
      period: '2026-09',
      limitMinor: 1_000_000,
      committedMinor: 160_000,
    },
  })
  created.budget.push(budget.id)
  const makePo = async (amount: number, suffix: string) => {
    const requisition = await db.requisition.create({
      data: {
        requestNumber: `REQ-${tag}-${suffix}`,
        requestedBy: maker,
        status: 'approved',
        costCenter: tag,
        budgetId: budget.id,
        lines: {
          create: {
            lineNo: 1,
            description: 'Goods',
            quantity: 1,
            unitPriceMinor: amount,
            lineTotalMinor: amount,
          },
        },
      },
    })
    created.requisition.push(requisition.id)
    const po = await db.purchaseOrder.create({
      data: {
        poNumber: `PO-${tag}-${suffix}`,
        requisitionId: requisition.id,
        vendorId: vendorId as string,
        status: 'confirmed',
        totalMinor: amount,
        issuedBy: maker,
        lines: {
          create: {
            lineNo: 1,
            description: 'Goods',
            quantity: 1,
            unitPriceMinor: amount,
            lineTotalMinor: amount,
          },
        },
      },
      include: { lines: true },
    })
    created.po.push(po.id)
    return po
  }
  const po = await makePo(100_000, 'A')
  const otherPo = await makePo(60_000, 'B')
  // Explicit fixture matching avoids global policy dependencies. Without a
  // receipt this simulates a stale historical match, which cancellation repairs.
  const invoice = await db.invoice.create({
    data: {
      vendorId,
      poId: po.id,
      number: `INV-${tag}`,
      amountMinor: 100_000,
      vatMinor: 12_000,
      ewtMinor: 1000,
      status: 'matched',
      matchResult: { outcome: 'matched' },
    },
  })
  created.invoice.push(invoice.id)
  const receipt = withReceipt
    ? await db.receipt.create({
        data: {
          receiptNumber: `GR-${tag}`,
          poId: po.id,
          vendorId,
          status: 'recorded',
          recordedBy: maker,
          lines: { create: { lineNo: 1, description: 'Goods', quantity: 1 } },
        },
      })
    : null
  if (receipt) created.receipt.push(receipt.id)
  const gate = await db.approval.create({
    data: {
      kind: 'poCancellation',
      poId: po.id,
      requisitionId: po.requisitionId,
      route: ['finance'],
      requestedBy: maker,
      status: 'pending',
      evidence: 'Fixture cancellation',
    },
  })
  created.approval.push(gate.id)
  return { po, otherPo, budget, invoice, receipt, gate }
}

async function makeRun(invoiceId: string, tx?: Prisma.TransactionClient) {
  const { run } = await runs.create({ invoiceIds: [invoiceId] }, maker, tx)
  created.run.push(run.id)
  return run
}

async function expectUnchanged(
  f: Awaited<ReturnType<typeof fixture>>,
  committedMinor = 160_000,
  spentMinor = 0,
) {
  expect(
    (await db.purchaseOrder.findUniqueOrThrow({ where: { id: f.po.id } }))
      .status,
  ).toBe('confirmed')
  expect(
    (await db.approval.findUniqueOrThrow({ where: { id: f.gate.id } })).status,
  ).toBe('pending')
  expect(
    await db.budget.findUniqueOrThrow({ where: { id: f.budget.id } }),
  ).toMatchObject({ committedMinor, spentMinor })
  expect(
    await db.domainEvent.count({
      where: { entityId: f.gate.id, type: 'approval.decided' },
    }),
  ).toBe(0)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function wait(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for transaction barrier')),
          4000,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
}

/** Observe actual lock statements without replacing their database execution. */
function observeInvoiceLock(
  tx: Prisma.TransactionClient,
  before?: () => void,
  after?: () => Promise<void>,
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property !== '$queryRaw') return Reflect.get(target, property)
      return async (
        query: TemplateStringsArray | Prisma.Sql,
        ...values: unknown[]
      ) => {
        const sql = Array.isArray(query)
          ? query.join('?')
          : (query as Prisma.Sql).sql
        const locksInvoice =
          sql.includes('FROM "invoice"') && sql.includes('FOR UPDATE')
        if (locksInvoice) before?.()
        const result = await target.$queryRaw(query, ...values)
        if (locksInvoice) await after?.()
        return result
      }
    },
  })
}

describe('PO cancellation financial invariants against PostgreSQL', () => {
  it('invalidates stale matched invoices and preserves the other PO commitment', async () => {
    const f = await fixture()
    expect(
      (await approvals.decide(f.gate.id, 'approve', checker)).outcome,
    ).toBe('PO_CANCELLED')
    expect(
      await db.budget.findUniqueOrThrow({ where: { id: f.budget.id } }),
    ).toMatchObject({ committedMinor: 60_000, spentMinor: 0 })
    expect(
      (
        await db.purchaseOrder.findUniqueOrThrow({
          where: { id: f.otherPo.id },
        })
      ).status,
    ).toBe('confirmed')
    expect(
      await db.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }),
    ).toMatchObject({
      status: 'exception',
      matchResult: expect.objectContaining({ outcome: 'po_not_live' }),
    })
    await expect(makeRun(f.invoice.id)).rejects.toThrow(/not payable/)
  })

  it.each(['approve', 'override'] as const)(
    'refuses %s after payment without losing another PO commitment',
    async (verdict) => {
      const f = await fixture(true)
      const run = await makeRun(f.invoice.id)
      await runs.approve(run.id, checker)
      await runs.execute(run.id, checker)
      await runs.reconcile(run.id, run.lines[0].id, 'paid')
      await expect(
        approvals.decide(f.gate.id, verdict, checker, 'Fixture override'),
      ).rejects.toThrow(/paid.*return\/refund/)
      await expectUnchanged(f, 60_000, 100_000)
      if (!f.receipt) throw new Error('Fixture receipt missing')
      await expect(receipts.cancel(f.receipt.id)).rejects.toThrow(
        /paid.*return\/refund/,
      )
      expect(
        (await db.receipt.findUniqueOrThrow({ where: { id: f.receipt.id } }))
          .status,
      ).toBe('recorded')
    },
  )

  it('requires voiding an unexecuted run and correcting receipts before cancellation', async () => {
    const f = await fixture(true)
    if (!f.receipt) throw new Error('Fixture receipt missing')
    const run = await makeRun(f.invoice.id)
    await expect(
      approvals.decide(f.gate.id, 'approve', checker),
    ).rejects.toThrow(/claimed by payment run/)
    await expectUnchanged(f)
    await runs.voidRun(
      run.id,
      checker,
      'Confirmed unexecuted; correct the receipt',
    )
    await expect(
      approvals.decide(f.gate.id, 'approve', checker),
    ).rejects.toThrow(/recorded receipt/)
    await expectUnchanged(f)
    await receipts.cancel(f.receipt.id)
    expect(
      (await approvals.decide(f.gate.id, 'approve', checker)).outcome,
    ).toBe('PO_CANCELLED')
    expect(
      (await db.budget.findUniqueOrThrow({ where: { id: f.budget.id } }))
        .committedMinor,
    ).toBe(60_000)
  })

  it('rolls back PO, invoice, gate, and events when the commitment is inconsistent', async () => {
    const f = await fixture()
    await db.budget.update({
      where: { id: f.budget.id },
      data: { committedMinor: 60_000 },
    })
    await expect(
      approvals.decide(f.gate.id, 'approve', checker),
    ).rejects.toThrow(/commitment is inconsistent/)
    await expectUnchanged(f, 60_000)
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .status,
    ).toBe('matched')
    expect(
      await db.domainEvent.count({
        where: { entityId: f.invoice.id, type: 'invoice.exception' },
      }),
    ).toBe(0)
  })

  it('blocks new planning against an already cancelled PO with a stale stored match', async () => {
    const f = await fixture()
    await db.purchaseOrder.update({
      where: { id: f.po.id },
      data: { status: 'cancelled' },
    })
    await expect(makeRun(f.invoice.id)).rejects.toThrow(/non-live PO/)
    expect(
      await db.paymentRunLine.count({ where: { invoiceId: f.invoice.id } }),
    ).toBe(0)
  })

  it('sees a payment claim committed while receipt correction waits for the invoice lock', async () => {
    const f = await fixture(true)
    if (!f.receipt) throw new Error('Fixture receipt missing')
    const receiptId = f.receipt.id
    const held = deferred()
    const release = deferred()
    const attempted = deferred()
    const planner = settled(
      db.$transaction(
        async (tx) => {
          const run = await makeRun(f.invoice.id, tx)
          held.resolve()
          await release.promise
          return run
        },
        { timeout: 15_000 },
      ),
    )
    let correction: ReturnType<typeof settled> | undefined
    try {
      await wait(held.promise)
      correction = settled(
        db.$transaction(
          (tx) =>
            receipts.cancel(
              receiptId,
              observeInvoiceLock(tx, attempted.resolve),
            ),
          { timeout: 15_000 },
        ),
      )
      await wait(attempted.promise)
    } finally {
      release.resolve()
      await planner
      if (correction) await correction
    }
    expect((await planner).status).toBe('fulfilled')
    expect(await correction).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConflictException),
    })
    expect(
      (await db.receipt.findUniqueOrThrow({ where: { id: receiptId } })).status,
    ).toBe('recorded')
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .status,
    ).toBe('matched')
  }, 20_000)

  it('rejects planning after receipt correction wins the invoice lock', async () => {
    const f = await fixture(true)
    if (!f.receipt) throw new Error('Fixture receipt missing')
    const receiptId = f.receipt.id
    const held = deferred()
    const release = deferred()
    const attempted = deferred()
    const correction = settled(
      db.$transaction(
        (tx) =>
          receipts.cancel(
            receiptId,
            observeInvoiceLock(tx, undefined, async () => {
              held.resolve()
              await release.promise
            }),
          ),
        { timeout: 15_000 },
      ),
    )
    let planner: ReturnType<typeof settled> | undefined
    try {
      await wait(held.promise)
      planner = settled(
        db.$transaction(
          (tx) =>
            makeRun(f.invoice.id, observeInvoiceLock(tx, attempted.resolve)),
          { timeout: 15_000 },
        ),
      )
      await wait(attempted.promise)
    } finally {
      release.resolve()
      await correction
      if (planner) await planner
    }
    expect((await correction).status).toBe('fulfilled')
    expect((await planner)?.status).toBe('rejected')
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
        .status,
    ).toBe('received')
    expect(
      await db.paymentRunLine.count({ where: { invoiceId: f.invoice.id } }),
    ).toBe(0)
  }, 20_000)

  it('blocks PO cancellation when planning commits while its invoice lock is pending', async () => {
    const f = await fixture()
    const held = deferred()
    const release = deferred()
    const attempted = deferred()
    const planner = settled(
      db.$transaction(
        async (tx) => {
          const run = await makeRun(f.invoice.id, tx)
          held.resolve()
          await release.promise
          return run
        },
        { timeout: 15_000 },
      ),
    )
    let cancellation: ReturnType<typeof settled> | undefined
    try {
      await wait(held.promise)
      cancellation = settled(
        db.$transaction(
          (tx) =>
            approvals.decide(
              f.gate.id,
              'approve',
              checker,
              undefined,
              observeInvoiceLock(tx, attempted.resolve),
            ),
          { timeout: 15_000 },
        ),
      )
      await wait(attempted.promise)
    } finally {
      release.resolve()
      await planner
      if (cancellation) await cancellation
    }
    expect((await planner).status).toBe('fulfilled')
    expect(await cancellation).toMatchObject({
      status: 'rejected',
      reason: expect.any(ConflictException),
    })
    await expectUnchanged(f)
  }, 20_000)
})
