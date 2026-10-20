import { vi } from 'vitest'

/** Fail closed if an isolated unit test accidentally reaches the real client. */
vi.mock('@workspace/db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Unit tests cannot access db.${String(property)}; inject a fake client or use the guarded integration suite`,
        )
      },
    },
  ),
  // Unit fixtures inject clients; no real Prisma runtime or connection is needed.
  // The tagged template only has to build something the fake clients accept:
  // they read the statement text, and a nested selection (the row-lock
  // helper) contributes its own text and values.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text: string[] = []
      const parameters: unknown[] = []
      strings.forEach((part, index) => {
        text.push(part)
        const value = values[index]
        if (value && typeof value === 'object' && 'raw' in value) {
          text.push(String((value as { raw: string }).raw))
        } else if (value && typeof value === 'object' && 'text' in value) {
          const nested = value as { text: string; values?: unknown[] }
          text.push(nested.text)
          parameters.push(...(nested.values ?? []))
        } else if (value !== undefined) {
          text.push('?')
          parameters.push(value)
        }
      })
      const statement = text.join('')
      return {
        text: statement,
        values: parameters,
        join: () => statement,
      }
    },
    empty: { text: '', values: [], join: () => '' },
    join: (values: unknown[]) => values,
    raw: (value: string) => ({ raw: value }),
  },
  // The engine is the deployed one unless a test says otherwise: the
  // PostgreSQL-specific statements stay on their production path.
  isSqlite: () => false,
  databaseProvider: () => 'postgres',
}))
