import { describe, expect, it } from 'vitest'
import { buildPaymentBatch } from '../src/payment-run/batch'
import {
  freezeBeneficiary,
  readBeneficiarySnapshot,
} from '../src/payment-run/beneficiary-snapshot'

const vendor = () => ({
  id: 'vendor',
  name: 'Supplier',
  taxId: null,
  bankAccount: { bank: 'BDO', accountNumber: '123', holder: 'Supplier' },
  bankAccountVerifiedAt: new Date(),
  bankAccountChangedAt: null,
})

describe('frozen beneficiary', () => {
  it('keeps payment bytes unchanged after vendor account changes', () => {
    const live = vendor()
    const snapshot = freezeBeneficiary('INV-1', live)
    const build = () =>
      buildPaymentBatch({
        runNumber: 'RUN-1',
        executedAt: new Date('2026-01-01'),
        totalMinor: 100,
        currencyCode: 'PHP',
        lines: [
          {
            ...readBeneficiarySnapshot(snapshot),
            lineId: 'line',
            invoiceId: 'invoice',
            netMinor: 100,
            currencyCode: 'PHP',
          },
        ],
      })
    const before = build()
    live.bankAccount.accountNumber = 'attacker-account'
    live.name = 'Changed name'
    expect(build()).toEqual(before)
    expect(snapshot.bankAccount.accountNumber).toBe('123')
  })

  it('refuses unverified or subsequently changed accounts', () => {
    expect(() =>
      freezeBeneficiary('INV-1', { ...vendor(), bankAccountVerifiedAt: null }),
    ).toThrow('Unverified')
    expect(() =>
      freezeBeneficiary('INV-1', {
        ...vendor(),
        bankAccountChangedAt: new Date(),
      }),
    ).toThrow('Unverified')
  })

  it('refuses malformed accounts and legacy missing snapshots', () => {
    expect(() =>
      freezeBeneficiary('INV-1', { ...vendor(), bankAccount: {} }),
    ).toThrow('Unverified')
    expect(() => readBeneficiarySnapshot(null)).toThrow(
      'recreate and reapprove',
    )
    expect(() => readBeneficiarySnapshot({ version: 1 })).toThrow(
      'recreate and reapprove',
    )
  })
})
