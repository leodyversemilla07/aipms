/** Tiny predicate evaluator for injected-client tests, not a PostgreSQL model. */
export function matches(row: Record<string, unknown>, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true
  return Object.entries(where).every(([field, expected]) => {
    if (field === 'AND' || field === 'OR') {
      const predicates = Array.isArray(expected) ? expected : [expected]
      return field === 'AND'
        ? predicates.every((predicate) => matches(row, predicate))
        : predicates.some((predicate) => matches(row, predicate))
    }
    const actual = row[field]
    if (expected !== null && typeof expected === 'object') {
      const filter = expected as Record<string, unknown>
      if ('not' in filter && actual === filter.not) return false
      if ('lt' in filter) {
        if (!(actual instanceof Date) || !(filter.lt instanceof Date))
          return false
        if (actual.getTime() >= filter.lt.getTime()) return false
      }
      return true
    }
    return actual === expected
  })
}
