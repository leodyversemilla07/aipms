/**
 * The agent run's skill list is stored as JSON so the column is portable
 * across engines (SQLite has no native scalar lists). The API always presents
 * it as a plain string array, so the contract never leaks a JSON blob.
 */
export function toSkillList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      }
    } catch {
      return []
    }
  }
  return []
}
