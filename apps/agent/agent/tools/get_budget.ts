import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from './trpc-client';

export default defineTool({
  description: 'Gets budget detail.',
  inputSchema: z.object({
    id: z.string()
  }),
  async execute(input) {
    return await trpcQuery('budget', 'detail', { id: input.id, includeRemaining: true });
  },
  toModelOutput(result: any) {
    if (!result) return 'Budget not found.';
    return `Budget ${result.id}\nLimit: ${result.limit}\nCommitted: ${result.committed}\nSpent: ${result.spent}\nRemaining: ${result.remaining}`;
  }
});
