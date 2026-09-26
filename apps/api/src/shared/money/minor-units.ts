import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'

/** Prisma `Int` maps to PostgreSQL INTEGER (signed 32-bit). */
export const DATABASE_INT_MAX = 2_147_483_647

export const nonnegativeMinorUnits = z
  .number()
  .int()
  .nonnegative()
  .max(DATABASE_INT_MAX)

export const positiveMinorUnits = z
  .number()
  .int()
  .positive()
  .max(DATABASE_INT_MAX)

export const positiveDatabaseInt = z
  .number()
  .int()
  .positive()
  .max(DATABASE_INT_MAX)

/** Normalize an ISO-style currency code at every money boundary. */
export function normalizeCurrencyCode(
  value: string,
  label = 'Currency',
): string {
  const code = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new BadRequestException(`${label} must be a three-letter code`)
  }
  return code
}

/** Refuse implicit FX: one workflow may contain exactly one currency. */
export function assertSingleCurrency(
  values: readonly string[],
  label: string,
): string {
  const currencies = new Set(
    values.map((value) => normalizeCurrencyCode(value, label)),
  )
  if (currencies.size !== 1) {
    throw new BadRequestException(
      `${label} must use one currency; currency conversion is not configured`,
    )
  }
  const [currency] = currencies
  if (currency === undefined) {
    throw new BadRequestException(`${label} requires a currency`)
  }
  return currency
}

/** Guard derived values before Prisma turns overflow into a database error. */
export function assertDatabaseInt(
  value: number,
  label: string,
  options: { nonnegative?: boolean } = {},
): number {
  const minimum = options.nonnegative === false ? -DATABASE_INT_MAX - 1 : 0
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > DATABASE_INT_MAX
  ) {
    throw new BadRequestException(
      `${label} exceeds the supported signed 32-bit integer range`,
    )
  }
  return value
}
