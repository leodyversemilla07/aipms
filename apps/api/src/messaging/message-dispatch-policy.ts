import type { Prisma } from '@workspace/db'

export const MESSAGE_DISPATCH_INTERVAL_MS = 5000
export const MESSAGE_DISPATCH_BATCH_SIZE = 25
export const EXTERNAL_DISPATCH_STALE_MS = 15 * 60 * 1000

/** Only durable, authorized rows with no unresolved prior attempt may send. */
export function stagedMessageWhere(): Prisma.MessageWhereInput {
  return {
    dispatchStartedAt: null,
    sentAt: null,
    transportMessageId: null,
    AND: [
      {
        OR: [
          { status: 'queued', tier: 'auto' },
          {
            status: 'approved',
            approvedBy: { not: null },
            approvedAt: { not: null },
          },
        ],
      },
      {
        OR: [
          { deliveryResolution: null },
          {
            deliveryResolution: 'confirmed_not_sent',
            deliveryResolutionEvidence: { not: null },
            deliveryResolvedBy: { not: null },
            deliveryResolvedAt: { not: null },
          },
        ],
      },
    ],
  }
}
