import './no-database'
import { describe, expect, it, vi } from 'vitest'
import { IntakeRouter } from '../../src/intake/intake.router'
import type { IntakeService } from '../../src/intake/intake.service'
import type { IntakeCommandService } from '../../src/intake/intake-command.service'
import type { InvoiceService } from '../../src/invoice/invoice.service'
import type { AuditService } from '../../src/shared/audit/audit.service'
import type { IdempotencyService } from '../../src/shared/idempotency/idempotency.service'
import type { AuthedTrpcContext } from '../../src/trpc/context.types'

const classified = {
  vendorId: 'vendor-1',
  number: 'INV-42',
  currencyCode: 'PHP',
  lines: [{ description: 'Paper', amountMinor: 1000, class: 'goods' as const }],
}

function fixtureDocument() {
  return {
    id: 'intake-1',
    channel: 'EMAIL_IMAP',
    contentHash: 'safe-content-hash',
    senderId: 'vendor-1',
    status: 'extracted' as const,
    receivedAt: new Date('2026-08-01T12:00:00Z'),
    raw: {
      text: 'Invoice INV-42\nBank account number: 1234 5678 9012 3456',
      bankAccount: 'sensitive-bank-account',
      attachments: [
        {
          filename: 'invoice.pdf',
          contentType: 'application/pdf',
          contentBase64: 'sensitive-binary-body',
          sha256: 'safe-attachment-hash',
        },
      ],
    },
    classified: { ...classified, apiToken: 'sensitive-classified-token' },
  }
}

type Document = ReturnType<typeof fixtureDocument>

function context(actorKind: 'human' | 'agent'): AuthedTrpcContext {
  // These tests exercise response shaping, not authentication/middleware.
  return {
    actorKind,
    session: null,
    user: { id: `fixture-${actorKind}`, kind: actorKind, role: 'finance' },
  } as AuthedTrpcContext
}

function fixture() {
  const document = fixtureDocument()
  const tx = {
    intakeDocument: { findUnique: vi.fn().mockResolvedValue(document) },
  }
  const intake = {
    list: vi.fn().mockResolvedValue([document]),
    detail: vi.fn().mockResolvedValue(document),
    ingest: vi.fn().mockResolvedValue(document),
    classify: vi.fn().mockResolvedValue(document),
    drop: vi.fn().mockResolvedValue(document),
    requeue: vi.fn().mockResolvedValue(document),
    attachInvoice: vi.fn().mockResolvedValue(document),
  }
  const commands = { ingest: vi.fn().mockResolvedValue(document) }
  const invoice = {
    register: vi.fn().mockResolvedValue({
      invoice: { id: 'invoice-1', status: 'matched' },
      match: { outcome: 'matched' },
    }),
  }
  const audit = { record: vi.fn().mockResolvedValue(undefined) }
  const idempotency = {
    runAtomic: vi.fn(async (_scope, work) => work(tx)),
  }
  const router = new IntakeRouter(
    intake as unknown as IntakeService,
    commands as unknown as IntakeCommandService,
    invoice as unknown as InvoiceService,
    idempotency as unknown as IdempotencyService,
    audit as unknown as AuditService,
  )
  return { router, document, intake, commands, invoice, audit, idempotency }
}

function expectSafeDocument(result: unknown, original: Document) {
  const document = result as Document
  expect(document).toMatchObject({
    id: original.id,
    channel: original.channel,
    contentHash: original.contentHash,
    senderId: original.senderId,
    status: original.status,
    receivedAt: original.receivedAt,
    classified: {
      vendorId: 'vendor-1',
      number: 'INV-42',
      lines: classified.lines,
    },
  })
  expect(document.raw.bankAccount).toBe('[REDACTED]')
  expect(document.classified.apiToken).toBe('[REDACTED]')
  expect(document.raw.attachments[0].contentBase64).toBe(
    '[BINARY CONTENT OMITTED]',
  )
  expect(document.raw.attachments[0].sha256).toBe('safe-attachment-hash')
  const serialized = JSON.stringify(document)
  for (const sensitive of [
    'sensitive-bank-account',
    'sensitive-classified-token',
    'sensitive-binary-body',
    '1234 5678 9012 3456',
  ]) {
    expect(serialized).not.toContain(sensitive)
  }
}

const commandInput = { id: 'intake-1', idempotencyKey: 'fixture-key' }
const mutations = [
  {
    name: 'ingest',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.ingest(
        {
          channel: 'API',
          contentHash: 'fixture-hash',
          idempotencyKey: 'fixture-key',
        },
        ctx,
      ),
  },
  {
    name: 'ingestStructured',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.ingestStructured(
        {
          channel: 'EINVOICE_EIS',
          content: JSON.stringify({
            NetSales: 100,
            TaxTotal: 12,
            ItemList: [],
          }),
          idempotencyKey: 'fixture-key',
        },
        ctx,
      ),
  },
  {
    name: 'classify',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.classify({ ...commandInput, classified }, ctx),
  },
  {
    name: 'drop',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.drop(commandInput, ctx),
  },
  {
    name: 'requeue',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.requeue(commandInput, ctx),
  },
  {
    name: 'registerInvoice',
    invoke: (router: IntakeRouter, ctx: AuthedTrpcContext) =>
      router.registerInvoice(commandInput, ctx),
  },
] as const

describe('intake response projection at the router boundary', () => {
  it('redacts every listed document for agents without mutating stored payloads', async () => {
    const { router, document, intake } = fixture()
    const original = structuredClone(document)
    intake.list.mockResolvedValue([document, { ...document, id: 'intake-2' }])
    const input = {
      q: '',
      sort: '',
      dir: 'asc' as const,
      page: 2,
      pageSize: 25,
    }
    const result = await router.list(input, context('agent'))
    expect(result).toHaveLength(2)
    expectSafeDocument(result[0], original)
    expectSafeDocument(result[1], { ...original, id: 'intake-2' })
    expect(document).toEqual(original)
    expect(intake.list).toHaveBeenCalledWith(input)
  })

  it('preserves full list payloads for humans and keeps the array response', async () => {
    const { router, document } = fixture()
    const result = await router.list(
      { q: '', sort: '', dir: 'asc', page: 1, pageSize: 25 },
      context('human'),
    )
    expect(result).toEqual([document])
    expect(result[0]).toBe(document)
  })

  it.each(['human', 'agent'] as const)(
    'projects detail for %s consistently with list',
    async (kind) => {
      const { router, document } = fixture()
      const result = await router.detail({ id: document.id }, context(kind))
      if (kind === 'agent') expectSafeDocument(result, document)
      else expect(result).toBe(document)
    },
  )

  for (const mode of ['fresh', 'cached'] as const) {
    describe(`${mode} mutation results`, () => {
      for (const kind of ['agent', 'human'] as const) {
        it.each(mutations)(
          `$name protects the ${kind} response`,
          async ({ name, invoke }) => {
            const { router, document, idempotency, audit, commands } = fixture()
            // Cached results are JSON, including date strings, just like runAtomic.
            const stored: Document =
              mode === 'cached'
                ? JSON.parse(JSON.stringify(document))
                : document
            const before = structuredClone(stored)
            if (mode === 'cached') {
              idempotency.runAtomic.mockResolvedValue(
                name === 'registerInvoice'
                  ? {
                      doc: stored,
                      invoice: { id: 'invoice-1', status: 'matched' },
                      match: { outcome: 'matched' },
                    }
                  : stored,
              )
            }
            const response = await invoke(router, context(kind))
            const result =
              name === 'registerInvoice'
                ? (response as { doc: Document }).doc
                : response
            if (kind === 'agent') expectSafeDocument(result, stored)
            else expect(result).toEqual(stored)
            expect(stored).toEqual(before)
            if (mode === 'cached') {
              expect(audit.record).not.toHaveBeenCalled()
              expect(commands.ingest).not.toHaveBeenCalled()
            } else if (name === 'ingest') {
              expect(commands.ingest).toHaveBeenCalledOnce()
            } else {
              expect(audit.record).toHaveBeenCalledOnce()
            }
            if (name === 'registerInvoice') {
              expect(response).toMatchObject({
                invoice: { id: 'invoice-1', status: 'matched' },
                match: { outcome: 'matched' },
              })
            }
          },
        )
      }
    })
  }

  it('keeps the unredacted outcome inside the idempotency callback', async () => {
    const { router, document, idempotency } = fixture()
    await router.classify({ ...commandInput, classified }, context('agent'))
    const stored = await idempotency.runAtomic.mock.results[0].value
    expect(stored).toBe(document)
    expect(stored.raw.bankAccount).toBe('sensitive-bank-account')
    expect(stored.classified.apiToken).toBe('sensitive-classified-token')
  })
})
