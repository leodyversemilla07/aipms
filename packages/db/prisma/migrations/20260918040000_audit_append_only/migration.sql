-- Enforce append-only audit history below the application layer. Maintenance
-- and integrity tests must opt in explicitly inside one transaction with:
--   SET LOCAL aipms.allow_audit_mutation = 'on';
CREATE OR REPLACE FUNCTION aipms_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('aipms.allow_audit_mutation', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'AuditEntry is append-only; UPDATE and DELETE are forbidden'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "AuditEntry_append_only"
BEFORE UPDATE OR DELETE ON "AuditEntry"
FOR EACH ROW
EXECUTE FUNCTION aipms_reject_audit_mutation();
