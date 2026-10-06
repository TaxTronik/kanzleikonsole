CREATE OR REPLACE FUNCTION app.guard_risk_analysis_archive()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tenant teardown cascades are an administrative lifecycle, not editing an
    -- individual archived analysis. The parent tenant is already absent then.
    IF OLD.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.tenant WHERE id = OLD.tenant_id) THEN
      RAISE EXCEPTION 'Archived risk analysis is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.archive_bucket IS NOT NULL OR NEW.archive_key IS NOT NULL THEN
      RAISE EXCEPTION 'New risk analysis must start unarchived' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'Risk analysis identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.archived_at IS NOT NULL THEN
    -- Confidentiality is live access policy and deliberately outside the snapshot.
    IF (to_jsonb(NEW) - 'vertraulich') = (to_jsonb(OLD) - 'vertraulich') THEN
      RETURN NEW;
    END IF;
    IF NEW.source_text = '' AND NEW.source_doc IS NULL
      AND (to_jsonb(NEW) - ARRAY['source_text', 'source_doc']) =
          (to_jsonb(OLD) - ARRAY['source_text', 'source_doc'])
      AND app.risk_retention_redaction_allowed(OLD.tenant_id, OLD.client_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Archived risk analysis is immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.archived_at IS NOT NULL THEN
    IF NEW.archive_bucket IS NULL OR NEW.archive_key IS NULL
      OR (to_jsonb(NEW) - ARRAY['archived_at', 'archive_bucket', 'archive_key']) <>
         (to_jsonb(OLD) - ARRAY['archived_at', 'archive_bucket', 'archive_key']) THEN
      RAISE EXCEPTION 'Archive transition may only bind an unchanged risk analysis'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.archive_bucket IS DISTINCT FROM OLD.archive_bucket OR NEW.archive_key IS DISTINCT FROM OLD.archive_key THEN
    RAISE EXCEPTION 'Risk archive pointer requires archive transition' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$function$;
