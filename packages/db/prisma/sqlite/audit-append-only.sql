-- The audit trail is append-only below the application layer.
--
-- PostgreSQL enforces this with the trigger created by the migration
-- `20260918040000_audit_append_only`. Its maintenance probes open the guard
-- with `SET LOCAL aipms.allow_audit_mutation = 'on'` inside one transaction.
--
-- The local SQLite database is created with `prisma db push`, which carries
-- no triggers, so the same guarantee is applied here. SQLite has no session
-- variables, so the guard is open while a row exists in
-- `aipmsAuditMaintenance`: a probe opens it inside the transaction it rolls
-- back, and every other writer still meets an append-only trail.
--
-- `ABORT` rolls the offending statement back instead of the whole
-- transaction. The statement fails, so the audit row never changes, and the
-- caller sees the same error the PostgreSQL trigger raises.

CREATE TABLE IF NOT EXISTS "aipmsAuditMaintenance" (
  "id" TEXT PRIMARY KEY,
  "reason" TEXT
);

CREATE TRIGGER IF NOT EXISTS "AuditEntry_append_only_update"
BEFORE UPDATE ON "AuditEntry"
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM "aipmsAuditMaintenance")
BEGIN
  SELECT RAISE(ABORT, 'AuditEntry is append-only; UPDATE and DELETE are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS "AuditEntry_append_only_delete"
BEFORE DELETE ON "AuditEntry"
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM "aipmsAuditMaintenance")
BEGIN
  SELECT RAISE(ABORT, 'AuditEntry is append-only; UPDATE and DELETE are forbidden');
END;
