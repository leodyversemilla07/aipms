import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from '../lib/trpc-client';

export default defineTool({
  description: 'Lists requisitions filtered by status.',
  inputSchema: z.object({
    status: z.string().optional(),
    page: z.number().optional().default(1),
    pageSize: z.number().optional().default(25),
  }),
  async execute(input) {
    return await trpcQuery('requisition', 'list', { q: input.status, page: input.page ?? 1, pageSize: input.pageSize ?? 25 });
  },
  toModelOutput(result: any) {
    const items = Array.isArray(result) ? result : result?.items;
    if (!items || !Array.isArray(items)) return 'No requisitions found.';
    const summary = items.map((req: any) => `- ID: ${req.id}, Status: ${req.status}, Title: ${req.title || 'Untitled'}`).join('\n');
    return `Found ${items.length} requisitions.\n${summary}`;
  }
});
