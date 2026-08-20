import { z } from 'zod';
import { defineTool } from 'eve/tools';
import { trpcQuery } from '../lib/trpc-client';

export default defineTool({
  description: 'Lists pending intake documents.',
  inputSchema: z.object({
    status: z.string().optional().default('new'),
  }),
  async execute(input) {
    return await trpcQuery('intake', 'list', { status: input.status ?? 'new' });
  },
  toModelOutput(result: any) {
    if (!result || !Array.isArray(result)) return 'No intake documents found.';
    const docs = result.map((doc: any) => `- ID: ${doc.id}, Status: ${doc.status}, Type: ${doc.type || 'Unknown'}`).join('\n');
    return `Found ${result.length} intake documents.\n${docs}`;
  }
});
