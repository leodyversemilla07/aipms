import { defineTool } from "eve/tools"
import { z } from "zod"
import { trpcQuery } from "./trpc-client"

export const listToolInput = z.object({
  q: z.string().default(""),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
})

const listResult = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  total: z.number().int().nonnegative(),
})

export async function fetchList(
  router: "catalog" | "vendor" | "budget",
  input: z.infer<typeof listToolInput>
) {
  return listResult.parse(await trpcQuery(router, "list", input))
}

export function defineListTool(
  router: "catalog" | "vendor" | "budget",
  description: string
) {
  return defineTool({
    description,
    inputSchema: listToolInput,
    async execute(input) {
      return fetchList(router, input)
    },
    toModelOutput(result) {
      // Preserve IDs, pagination totals and exact minor-unit monetary fields.
      return { type: "text", value: JSON.stringify(result) }
    },
  })
}
