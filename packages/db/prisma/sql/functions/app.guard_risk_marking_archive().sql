CREATE OR REPLACE FUNCTION app.guard_risk_marking_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE
  parent_id UUID;
  parent_tenant UUID;
  parent_archived TIMESTAMPTZ;
  parent_client UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
    OR NEW.analysis_id IS DISTINCT FROM OLD.analysis_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN
    RAISE EXCEPTION 'Risk marking identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD.analysis_id;
    parent_tenant := OLD.tenant_id;
  ELSE
    parent_id := NEW.analysis_id;
    parent_tenant := NEW.tenant_id;
  END IF;

  -- Serializes inserts/updates/deletes with snapshot reads and final CAS. After
  -- waiting PostgreSQL reads the committed parent version, including archived_at.
  SELECT archived_at, client_id INTO parent_archived, parent_client
    FROM public.risk_analysis WHERE id = parent_id AND tenant_id = parent_tenant FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; -- parent/tenant cascade
    RAISE EXCEPTION 'Risk analysis not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_archived IS NOT NULL THEN
    IF TG_OP = 'UPDATE' THEN
      IF to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
      IF NEW.matched_text = '' AND NEW.notiz IS NULL
        AND (to_jsonb(NEW) - ARRAY['matched_text', 'notiz', 'updated_at']) =
            (to_jsonb(OLD) - ARRAY['matched_text', 'notiz', 'updated_at'])
        AND app.risk_retention_redaction_allowed(parent_tenant, parent_client) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Archived risk marking is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
