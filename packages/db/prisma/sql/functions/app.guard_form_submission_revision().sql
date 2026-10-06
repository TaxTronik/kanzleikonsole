CREATE OR REPLACE FUNCTION app.guard_form_submission_revision()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE s public.form_submission; r public.form_submission_revision; v public.document_version; d public.document;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Submitted form revision is immutable'; END IF;
 IF TG_TABLE_NAME='form_submission_revision' THEN
  SELECT * INTO s FROM public.form_submission WHERE id=NEW.submission_id FOR SHARE;
  IF s.id IS NULL OR s.tenant_id<>NEW.tenant_id OR s.status NOT IN ('SUBMITTED','REVIEWED') OR s.schema_snapshot IS DISTINCT FROM NEW.schema_snapshot OR s.answers IS DISTINCT FROM NEW.answers OR s.submitted_at IS DISTINCT FROM NEW.submitted_at OR s.submitted_by_contact IS DISTINCT FROM NEW.submitted_by_contact THEN RAISE EXCEPTION 'Revision does not match submitted form'; END IF;
 ELSE
  SELECT * INTO r FROM public.form_submission_revision WHERE id=NEW.revision_id;
  SELECT * INTO v FROM public.document_version WHERE id=NEW.document_version_id;
  SELECT * INTO d FROM public.document WHERE id=v.document_id;
  IF r.id IS NULL OR v.id IS NULL OR d.tenant_id<>r.tenant_id OR d.form_submission_id IS DISTINCT FROM r.submission_id OR d.form_field_key IS DISTINCT FROM NEW.field_key OR r.answers->NEW.field_key->>'documentId' IS DISTINCT FROM d.id::text OR v.scan_status<>'CLEAN' OR v.storage_version_id IS NULL OR v.created_at>r.submitted_at OR encode(v.sha256,'hex')<>NEW.sha256 OR EXISTS(SELECT 1 FROM public.document_version newer WHERE newer.document_id=d.id AND newer.version_no>v.version_no AND newer.created_at<=r.submitted_at) THEN RAISE EXCEPTION 'Frozen form file source mismatch'; END IF;
 END IF;
 RETURN NEW;
END $function$;
