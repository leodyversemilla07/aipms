import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from './trpc-client';

export default defineTool({
  description: 'Computes deterministic tax for invoice lines.',
  inputSchema: z.object({
    lines: z.array(z.object({
      description: z.string().optional(),
      amountMinor: z.number(),
      class: z.string(),
      vatExempt: z.boolean().optional()
    }))
  }),
  async execute(input) {
    return await trpcQuery('invoice', 'compute', { lines: input.lines });
  },
  toModelOutput(result: any) {
    if (!result) return 'Could not compute tax.';
    return `Gross: ${result.grossAmount}\nVAT: ${result.vatAmount}\nEWT: ${result.ewtAmount}\nNet Payable: ${result.netPayableAmount}`;
  }
});
