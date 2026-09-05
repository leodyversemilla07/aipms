import { z } from 'zod'
import { parseBeneficiary } from './batch'

const snapshotSchema = z.object({
  version: z.literal(1),
  invoiceNumber: z.string().min(1),
  vendorId: z.string().min(1),
  vendorName: z.string().min(1),
  vendorTaxId: z.string().nullable(),
  bankAccount: z.object({
    bank: z.string().min(1),
    accountNumber: z.string().min(1),
    holder: z.string().min(1),
  }),
})

export function freezeBeneficiary(
  invoiceNumber: string,
  vendor: {
    id: string
    name: string
    taxId: string | null
    bankAccount: unknown
    bankAccountVerifiedAt: Date | null
    bankAccountChangedAt: Date | null
  },
) {
  const bankAccount = parseBeneficiary(vendor.bankAccount)
  if (
    !bankAccount ||
    !vendor.bankAccountVerifiedAt ||
    vendor.bankAccountChangedAt
  ) {
    throw new Error(`Unverified beneficiary account for: ${vendor.name}`)
  }
  return snapshotSchema.parse({
    version: 1,
    invoiceNumber,
    vendorId: vendor.id,
    vendorName: vendor.name,
    vendorTaxId: vendor.taxId,
    bankAccount,
  })
}

export function readBeneficiarySnapshot(value: unknown) {
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      'Payment run has no valid frozen beneficiary snapshot; recreate and reapprove the run',
    )
  }
  return parsed.data
}
