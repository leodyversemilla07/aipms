import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from './trpc-client';

export default defineTool({
  description: 'Lists vendors.',
  inputSchema: z.object({
    q: z.string().optional(),
    page: z.number().optional().default(1),
    pageSize: z.number().optional().default(25),
  }),
  async execute(input) {
    return await trpcQuery('vendor', 'list', input);
  },
  toModelOutput(result: any) {
    const items = Array.isArray(result) ? result : result?.items;
    if (!items || !Array.isArray(items)) return 'No vendors found.';
    const summary = items.map((v: any) => `- ID: ${v.id}, Name: ${v.name}, Status: ${v.status}`).join('\n');
    return `Found ${items.length} vendors.\n${summary}`;
  }
});
