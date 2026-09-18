import { db } from '@workspace/db'

function positiveTimeout(value: string | undefined, fallback = 900_000) {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback
}

/**
 * Low-cardinality operational exception gauges shared by the authenticated
 * recovery desk and the machine-readable monitoring endpoint.
 */
export async function getRecoverySummary() {
  const now = Date.now()
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
    ambiguousErpDispatches,
  ] = await Promise.all([
    db.domainEvent.count({ where: { deadLetteredAt: { not: null } } }),
    db.domainEvent.count({ where: { dispatchClaimId: { not: null } } }),
    db.domainEvent.count({
      where: {
        dispatchClaimId: { not: null },
        dispatchClaimedAt: { lt: claimStaleBefore },
      },
    }),
    db.agentRun.count({
      where: { status: 'running', startedAt: { lt: runStaleBefore } },
    }),
    db.message.count({ where: { status: 'failed' } }),
    db.erpJournalExport.count({
      where: {
        status: 'exported',
        dispatchClaimId: { not: null },
        dispatchFailure: { not: null },
        dispatchResolvedAt: null,
      },
    }),
  ])
  return {
    deadLetters,
    relayClaims,
    staleRelayClaims,
    staleAgentRuns,
    failedMessages,
    ambiguousErpDispatches,
    checkedAt: new Date(),
  }
}
