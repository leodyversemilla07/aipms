import { db } from '@workspace/db'
import { EXTERNAL_DISPATCH_STALE_MS } from '../../messaging/message-dispatch-policy'

function positiveTimeout(value: string | undefined, fallback = 900_000) {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback
}

/**
 * Low-cardinality operational exception gauges shared by the authenticated
 * recovery desk and the machine-readable monitoring endpoint.
 */
export async function getRecoverySummary(client: typeof db = db) {
  const now = Date.now()
  const dispatchStaleBefore = new Date(now - EXTERNAL_DISPATCH_STALE_MS)
  const claimStaleBefore = new Date(
    now - positiveTimeout(process.env.EVENT_RELAY_CLAIM_TTL_MS),
  )
  const runStaleBefore = new Date(
    now - positiveTimeout(process.env.AUTOMATION_LEASE_TIMEOUT_MS),
  )
  const [
    deadLetters,
    relayClaims,
    staleRelayClaims,
    staleAgentRuns,
    failedMessages,
    staleStagedMessages,
    staleSendingMessages,
    ambiguousErpDispatches,
  ] = await Promise.all([
    client.domainEvent.count({ where: { deadLetteredAt: { not: null } } }),
    client.domainEvent.count({ where: { dispatchClaimId: { not: null } } }),
    client.domainEvent.count({
      where: {
        dispatchClaimId: { not: null },
        dispatchClaimedAt: { lt: claimStaleBefore },
      },
    }),
    client.agentRun.count({
      where: { status: 'running', startedAt: { lt: runStaleBefore } },
    }),
    client.message.count({ where: { status: 'failed' } }),
    client.message.count({
      where: {
        OR: [{ status: 'queued', tier: 'auto' }, { status: 'approved' }],
        updatedAt: { lt: dispatchStaleBefore },
      },
    }),
    client.message.count({
      where: {
        status: 'sending',
        OR: [
          { dispatchStartedAt: { lt: dispatchStaleBefore } },
          { dispatchStartedAt: null },
        ],
      },
    }),
    client.erpJournalExport.count({
      where: {
        status: 'exported',
        dispatchClaimId: { not: null },
        dispatchResolvedAt: null,
        OR: [
          { dispatchFailure: { not: null } },
          { dispatchStartedAt: { lt: dispatchStaleBefore } },
          { dispatchStartedAt: null },
        ],
      },
    }),
  ])
  return {
    deadLetters,
    relayClaims,
    staleRelayClaims,
    staleAgentRuns,
    failedMessages,
    staleStagedMessages,
    staleSendingMessages,
    ambiguousErpDispatches,
    checkedAt: new Date(),
  }
}
