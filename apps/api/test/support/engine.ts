import { isSqlite } from '@workspace/db'

/**
 * Probes that only PostgreSQL can run.
 *
 * SQLite serialises writers for the whole transaction, so it cannot show the
 * interleaving these probes are built around: a row lock that blocks, a
 * reader that must not see an uncommitted row, a second writer that waits.
 * They stay in the suite and run on the deployed engine; the local SQLite
 * run skips them instead of reporting a failure it cannot produce.
 */
export const postgresOnly = isSqlite()
