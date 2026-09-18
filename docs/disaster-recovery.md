# Disaster-recovery validation

A backup is not release evidence until its checksum, freshness, and restore path
have been tested. `scripts/production-smoke.sh` performs a destructive round
trip against an isolated ephemeral stack on every CI run. A staging drill is
still required because it validates the real object store, credentials,
container runtime, network, storage, and operator procedure.

## Backup freshness monitor

Run after every scheduled backup and independently from the monitoring host:

```bash
BACKUP_MAX_AGE_SECONDS=90000 \
  ./scripts/backup-health.sh /var/backups/aipms
```

The check fails when no archive exists, the newest archive is stale, its
SHA-256 sidecar is absent or invalid, gzip integrity fails, or the archive is
implausibly small. It emits one low-cardinality JSON record on success. Copy the
archive and sidecar to encrypted off-host storage only after this check passes.
Alert when the command fails or no success record arrives within the RPO.

## Quarterly staging restore drill

1. Open a change record with the source backup identifier, expected RPO/RTO,
   image digest, schema version, operators, and rollback owner.
2. Select the newest validated off-host archive and checksum sidecar. Download
   them to a restricted directory (`umask 077`) without changing the names.
3. Create an isolated Compose project and staging database. Verify all public
   URLs, credentials, queues, mailboxes, and ERP connections point to staging
   or inert test endpoints. Never run a drill against production DNS or a
   production payment/messaging provider.
4. Start PostgreSQL only, then run:

   ```bash
   COMPOSE_PROJECT_NAME=aipms-drill-YYYYQX \
   POSTGRES_DB=aipms_drill \
   ./scripts/restore.sh /restricted/aipms-YYYYMMDD-HHMMSS.sql.gz
   ```

   `restore.sh` validates gzip and SHA-256, restores first into a disposable
   database, checks the Prisma migration ledger, stops writers, terminates
   stale sessions, restores transactionally, and fails closed if any step
   fails.
5. Start the release-candidate API and web images. Verify `/health/ready`, the
   authenticated `/health/operations` endpoint, login/SSO, authorization
   boundaries, the Operations desk, and the audit-chain integrity check.
6. Reconcile representative counts for vendors, requisitions, invoices,
   payment runs, audit entries, domain events, and SCIM identities against the
   source backup manifest. Inspect recovery queues; do not replay them merely
   to make a drill green.
7. Run read-only capacity validation and one synthetic procure-to-pay journey
   using staging-only identities and providers.
8. Record measured backup age, restore start/end, achieved RPO/RTO, migration
   output, health/capacity results, discrepancies, and remediation owners.
9. Destroy the staging database, downloaded archive, temporary credentials,
   and isolated volumes according to the data-retention policy.

## Failure rules

- A failed validation must leave application writers stopped.
- Never automatically retry an ERP posting or outbound message whose external
  outcome is ambiguous.
- Never bypass maker/checker controls to complete a drill.
- Do not edit `_prisma_migrations`, audit entries, dispatch claims, or recovery
  provenance manually.
- A successful database restore with failed audit, identity, or financial
  reconciliation is a failed drill.
