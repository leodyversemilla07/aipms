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
