CREATE OR REPLACE FUNCTION app.check_workflow_expansion_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_TABLE_NAME='year_end_campaign' THEN
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Campaign revision is immutable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.form_template WHERE id=NEW.template_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Campaign template scope mismatch'; END IF;
 ELSIF TG_TABLE_NAME='year_end_campaign_entry' THEN
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Campaign allocation is immutable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.year_end_campaign c JOIN public.form_submission s ON s.id=NEW.submission_id JOIN public.request r ON r.id=NEW.request_id WHERE c.id=NEW.campaign_id AND c.tenant_id=NEW.tenant_id AND s.tenant_id=NEW.tenant_id AND s.client_id=NEW.client_id AND r.tenant_id=NEW.tenant_id AND r.client_id=NEW.client_id AND r.form_submission_id=s.id AND s.schema_snapshot=c.schema_snapshot) THEN RAISE EXCEPTION 'Campaign allocation scope mismatch'; END IF;
 ELSE
   IF TG_OP='INSERT' THEN
    IF NEW.status<>'OPEN' OR NEW.response IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'Interaction must start open'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.client_contact c JOIN public.request r ON r.id=NEW.request_id WHERE c.id=NEW.contact_id AND c.tenant_id=NEW.tenant_id AND c.client_id=NEW.client_id AND c.active AND r.client_id=NEW.client_id AND r.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Interaction scope mismatch'; END IF;
    IF NEW.kind='NOTICE' AND NOT EXISTS(SELECT 1 FROM public.tax_notice WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id) THEN RAISE EXCEPTION 'Notice scope mismatch'; END IF;
    IF NEW.kind='FEEDBACK' AND NOT EXISTS(SELECT 1 FROM public.workflow_instance WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND status='COMPLETED') THEN RAISE EXCEPTION 'Milestone is not complete'; END IF;
   ELSE
    IF ROW(NEW.tenant_id,NEW.client_id,NEW.contact_id,NEW.kind,NEW.source_id,NEW.request_id,NEW.snapshot,NEW.expires_at,NEW.created_by_staff,NEW.revision) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.client_id,OLD.contact_id,OLD.kind,OLD.source_id,OLD.request_id,OLD.snapshot,OLD.expires_at,OLD.created_by_staff,OLD.revision) THEN RAISE EXCEPTION 'Interaction snapshot is immutable'; END IF;
    IF app.current_actor_type()<>'CLIENT_CONTACT' AND ROW(NEW.response,NEW.message,NEW.responded_at) IS DISTINCT FROM ROW(OLD.response,OLD.message,OLD.responded_at) THEN RAISE EXCEPTION 'Only designated contact may respond'; END IF;
    IF OLD.status<>'OPEN' AND ROW(NEW.response,NEW.message,NEW.responded_at,NEW.status) IS DISTINCT FROM ROW(OLD.response,OLD.message,OLD.responded_at,OLD.status) THEN RAISE EXCEPTION 'Response is immutable'; END IF;
    IF app.current_actor_type()='CLIENT_CONTACT' THEN
      IF OLD.status<>'OPEN' OR NEW.status<>'RESPONDED' OR OLD.expires_at<=CURRENT_TIMESTAMP OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by_staff IS DISTINCT FROM OLD.reviewed_by_staff THEN RAISE EXCEPTION 'Invalid interaction response'; END IF;
      PERFORM id FROM public.request WHERE id=NEW.request_id AND status IN ('OPEN','IN_PROGRESS') FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Interaction request is closed'; END IF;
      NEW.responded_at:=CURRENT_TIMESTAMP;
      IF NEW.kind='NOTICE' AND NOT EXISTS(SELECT 1 FROM public.tax_notice n JOIN public.document d ON d.id=n.document_id JOIN public.document_version v ON v.document_id=d.id WHERE n.id=NEW.source_id AND n.status='GEPRUEFT' AND n.updated_at=(NEW.snapshot->>'noticeUpdatedAt')::timestamptz AND d.shared_with_client_at IS NOT NULL AND d.deleted_at IS NULL AND v.id=(NEW.snapshot->>'documentVersionId')::uuid AND NOT EXISTS(SELECT 1 FROM public.document_version newer WHERE newer.document_id=d.id AND newer.version_no>v.version_no)) THEN RAISE EXCEPTION 'Notice revision changed'; END IF;
    END IF;
   END IF;
 END IF;
 RETURN NEW;
END $function$;
