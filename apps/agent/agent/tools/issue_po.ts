import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcMutate } from './trpc-client';
import crypto from 'crypto';

export default defineTool({
  description: 'Issues a PO from an approved requisition.',
  inputSchema: z.object({
    requisitionId: z.string(),
    vendorId: z.string(),
    idempotencyKey: z.string().optional(),
    terms: z.record(z.any()).optional()
  }),
  async execute(input) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
    return await trpcMutate('purchaseOrder', 'issue', { 
      idempotencyKey, 
      requisitionId: input.requisitionId, 
      vendorId: input.vendorId, 
      terms: input.terms 
    });
  },
  toModelOutput(result: any) {
    return `PO Issued: ${result?.poNumber || result?.id} (Status: ${result?.status})\nTotal: ${result?.totalAmount}\nVendor: ${result?.vendorId}`;
  }
});
