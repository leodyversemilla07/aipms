import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from '../lib/trpc-client';

export default defineTool({
  description: 'Gets full requisition detail.',
  inputSchema: z.object({
    id: z.string()
  }),
  async execute(input) {
    return await trpcQuery('requisition', 'detail', { id: input.id });
  },
  toModelOutput(result: any) {
    if (!result) return 'Requisition not found.';
    const lines = result.lines ? result.lines.length : 0;
    return `Requisition ${result.number || result.id}\nStatus: ${result.status}\nLines: ${lines}\nBudget: ${result.budgetId || 'None'}`;
  }
});
