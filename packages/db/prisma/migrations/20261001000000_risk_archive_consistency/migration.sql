-- RISK-ARCHIVE-SNAPSHOT-001; DSGVO-MANDATE-ANONYMIZATION-001.
-- Keep archive core data immutable even for raw SQL, nested Prisma writes and
-- owner-worker writes. Normal writers explicitly lock parent -> child as well.
-- No historical archive is rewritten. Existing live-data redaction remains the
-- sole content exception; it never changes the immutable object-store snapshot.

CREATE OR REPLACE FUNCTION app.risk_retention_redaction_allowed(tid UUID, cid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public, app AS $$
  SELECT app.current_actor_type() = 'STAFF'
    AND tid = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.staff_user s JOIN public.staff_role r ON r.staff_user_id = s.id
       WHERE s.id = app.current_actor_id() AND s.tenant_id = tid AND s.active
         AND r.role IN ('ADMIN', 'PARTNER')
    )
    AND EXISTS (
      SELECT 1 FROM public.client c WHERE c.id = cid AND c.tenant_id = tid
        AND c.kind = 'NATPERS' AND c.anonymized_at IS NOT NULL
        AND c.mandate_ended_at IS NOT NULL
        AND make_date(EXTRACT(YEAR FROM c.mandate_ended_at)::integer + 11, 1, 1)
          <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
    )
$$;

CREATE OR REPLACE FUNCTION app.guard_risk_analysis_archive()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
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
$$;

CREATE OR REPLACE FUNCTION app.guard_risk_marking_archive()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
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
$$;

CREATE TRIGGER risk_analysis_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.risk_analysis
FOR EACH ROW EXECUTE FUNCTION app.guard_risk_analysis_archive();

CREATE TRIGGER risk_marking_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.risk_marking
FOR EACH ROW EXECUTE FUNCTION app.guard_risk_marking_archive();
