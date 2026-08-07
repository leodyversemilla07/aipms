import { z } from 'zod'

export const listInput = z.object({
  q: z.string().default(''),
  sort: z.string().default(''),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
})

export type ListInput = z.infer<typeof listInput>

type FacetCounts = Record<string, Record<string, number>>

export type ListResult<TRow> = {
  rows: TRow[]
  total: number
  facetCounts: FacetCounts
}

export function paginate(input: Pick<ListInput, 'page' | 'pageSize'>): {
  skip: number
  take: number
} {
  return {
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
  }
}

export function resolveOrderBy<TOrderBy>(
  input: Pick<ListInput, 'sort' | 'dir'>,
  columns: Record<string, (dir: 'asc' | 'desc') => TOrderBy>,
  fallback: TOrderBy,
): TOrderBy {
  const column = columns[input.sort]
  return column ? column(input.dir) : fallback
}
