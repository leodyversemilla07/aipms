import { expect } from 'vitest'

/**
 * The text of a database error, including the driver's own cause.
 *
 * PostgreSQL surfaces a trigger's message directly. The SQLite driver
 * adapter reports the same refusal as a constraint violation and keeps the
 * trigger's text in the error's cause, so an assertion about what the
 * database said reads the whole error instead of one field of it.
 */
export function databaseErrorText(error: unknown): string {
  const parts: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || value === undefined) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (typeof value !== 'object') return
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === 'message' || key === 'originalMessage') {
        if (typeof nested === 'string') parts.push(nested)
        continue
      }
      visit(nested, depth + 1)
    }
  }
  visit(error, 0)
  return parts.join(' | ')
}

/**
 * Asserts that the database refused the operation, and said why.
 *
 * The refusal is the point; the wording is the database's business, so the
 * assertion reads the message the driver carries.
 */
export async function expectDatabaseRefusal(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (error === undefined) {
    throw new Error(
      `Expected the database to refuse the operation (${pattern})`,
    )
  }
  expect(databaseErrorText(error)).toMatch(pattern)
}
