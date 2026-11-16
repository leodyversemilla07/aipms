import './no-database'
import { describe, expect, it, vi } from 'vitest'
import { AgentService } from '../../src/agent/agent.service'

/**
 * The agent pipeline runs inside one transaction. Every read it makes has to
 * come from that transaction: a read through the shared connection looks
 * outside the transaction, and the SQLite driver adapter serialises every
 * statement on a connection behind the open transaction - the read would wait
 * for the transaction it belongs to.
 */
describe('agent pipeline transaction scope', () => {
  const raw = {
    docType: 'invoice',
    payload: {
      vendorId: 'vendor-1',
      number: 'INV-1',
      lines: [{ amountMinor: 1000, class: 'goods' }],
    },
  }

  function fixture() {
    const tx = {
      intakeDocument: {
        findUnique: vi.fn(async () => ({ id: 'doc-1', status: 'new' })),
      },
    }
    const detail = vi.fn(async () => ({ id: 'doc-1', status: 'new', raw }))
    const classify = vi.fn(async () => ({ id: 'doc-1', status: 'extracted' }))
    const attachInvoice = vi.fn(async () => ({
      id: 'doc-1',
      status: 'matched',
    }))
    const register = vi.fn(async () => ({
      invoice: { id: 'invoice-1', status: 'matched' },
      match: null,
    }))
    const service = new AgentService(
      { detail, classify, attachInvoice } as never,
      { register } as never,
    )
    return { service, tx, detail, classify, attachInvoice, register }
  }

  it('reads the intake preview through the caller transaction', async () => {
    const f = fixture()
    await f.service.classifyAndRegister('doc-1', f.tx as never)
    expect(f.detail).toHaveBeenCalledWith('doc-1', f.tx)
  })

  it('keeps the classify, register and bridge steps inside the same transaction', async () => {
    const f = fixture()
    await f.service.classifyAndRegister('doc-1', f.tx as never)
    expect(f.classify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1' }),
      f.tx,
    )
    expect(f.register).toHaveBeenCalledWith(expect.anything(), f.tx)
    expect(f.attachInvoice).toHaveBeenCalledWith(
      'doc-1',
      'invoice-1',
      'matched',
      f.tx,
    )
  })

  it('refuses a dropped document before it touches the transaction', async () => {
    const f = fixture()
    f.detail.mockResolvedValueOnce({
      id: 'doc-1',
      status: 'dropped',
      raw,
    } as never)
    await expect(
      f.service.classifyAndRegister('doc-1', f.tx as never),
    ).rejects.toThrow(/Dropped document/)
    expect(f.classify).not.toHaveBeenCalled()
  })
})
