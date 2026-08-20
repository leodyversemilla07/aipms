import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcMutate } from '../lib/trpc-client';
import crypto from 'crypto';

export default defineTool({
  description: 'Promotes a classified intake document to an invoice.',
  inputSchema: z.object({
    id: z.string(),
    idempotencyKey: z.string().optional()
  }),
  async execute(input) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
    return await trpcMutate('intake', 'registerInvoice', { id: input.id, idempotencyKey });
  },
  toModelOutput(result: any) {
    return `Registered Invoice: ${result?.invoiceId || 'Unknown ID'} (Status: ${result?.status || 'Unknown'}). Match outcome: ${result?.matchOutcome || 'None'}`;
  }
});
