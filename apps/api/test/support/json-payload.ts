import { isSqlite } from '@workspace/db'

/**
 * Portable JSON payload predicates for the test suite.
 *
 * Prisma's JSON path filter (`{ path: ['a'], equals: x }`) is a PostgreSQL
 * feature: SQLite stores the payload as text, so the same comparison has to
 * run after the read there. These helpers keep one query style in the suite
 * on both engines instead of branching at every call site.
 */

type Row = { id: string }

/** The model delegate the helpers read from. */
type Model<T extends Row = Row> = {
  findMany(args: never): Promise<T[]>
}

/** Reads the value at `path` inside a JSON payload. */
export function readJsonPath(payload: unknown, path: string[]): unknown {
  let current = payload
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Reads the rows whose JSON payload field equals one of `values`.
 *
 * `where` narrows the rows first on both engines; the payload field selects
 * the row on top of that.
 */
export async function findManyByJsonPayload<T extends Row = Row>(
  model: Model<T>,
  column: string,
  path: string[],
  values: readonly unknown[],
  where: Record<string, unknown> = {},
): Promise<T[]> {
  if (values.length === 0) return []
  if (!isSqlite()) {
    return model.findMany({
      where: {
        AND: [
          where,
          { OR: values.map((equals) => ({ [column]: { path, equals } })) },
        ],
      },
    } as never)
  }
  const rows = await model.findMany({ where } as never)
  return rows.filter((row) =>
    values.includes(
      readJsonPath((row as unknown as Record<string, unknown>)[column], path),
    ),
  )
}

/**
 * Deletes the rows whose JSON payload field equals one of `values`.
 *
 * The PostgreSQL statement deletes in one query; SQLite reads the matching
 * rows first and deletes them by id, because the payload lives in a text
 * column there.
 */
export async function deleteManyByJsonPayload(
  model: Model & { deleteMany(args: never): Promise<{ count: number }> },
  column: string,
  path: string[],
  values: readonly unknown[],
  where: Record<string, unknown> = {},
): Promise<{ count: number }> {
  if (values.length === 0) return { count: 0 }
  if (!isSqlite()) {
    return model.deleteMany({
      where: {
        AND: [
          where,
          { OR: values.map((equals) => ({ [column]: { path, equals } })) },
        ],
      },
    } as never)
  }
  const rows = await findManyByJsonPayload(model, column, path, values, where)
  if (rows.length === 0) return { count: 0 }
  return model.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  } as never)
}
