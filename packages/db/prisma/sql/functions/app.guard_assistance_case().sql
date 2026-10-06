CREATE OR REPLACE FUNCTION app.guard_assistance_case()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'tenant/client mismatch'; END IF;
 IF NEW.source_document_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document_version v JOIN public.document d ON d.id=v.document_id WHERE v.id=NEW.source_document_version_id AND d.tenant_id=NEW.tenant_id AND d.client_id=NEW.client_id AND d.deleted_at IS NULL AND d.gwg_destroyed_at IS NULL AND d.gwg_destruction_requested_at IS NULL AND d.classification NOT IN('GWG_EVIDENCE','STAFF_PRIVATE','PERSONNEL') AND (to_jsonb(d)->>'requires_payroll_access') IS DISTINCT FROM 'true' AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL AND encode(v.sha256,'hex')=NEW.source_hash AND (app.current_actor_type()<>'CLIENT_CONTACT' OR d.shared_with_client_at IS NOT NULL)) THEN RAISE EXCEPTION 'invalid original document'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.client_id,NEW.kind,NEW.title,NEW.schema_snapshot) IS DISTINCT FROM (OLD.tenant_id,OLD.client_id,OLD.kind,OLD.title,OLD.schema_snapshot) THEN RAISE EXCEPTION 'immutable template snapshot'; END IF;
  IF (OLD.source_document_version_id IS NOT NULL OR OLD.status<>'DRAFT') AND (NEW.source_document_version_id,NEW.source_hash) IS DISTINCT FROM (OLD.source_document_version_id,OLD.source_hash) THEN RAISE EXCEPTION 'immutable original snapshot'; END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'invalid revision'; END IF;
  IF OLD.status NOT IN ('DRAFT','RETURNED') AND NEW.answers IS DISTINCT FROM OLD.answers THEN RAISE EXCEPTION 'submitted answers are immutable'; END IF;
 END IF;
 IF app.current_actor_type()='CLIENT_CONTACT' THEN
  IF NEW.status NOT IN ('DRAFT','SUBMITTED') THEN RAISE EXCEPTION 'staff review required'; END IF;
  IF TG_OP='INSERT' AND (NEW.reviewed_by_staff IS NOT NULL OR NEW.review_note IS NOT NULL) THEN RAISE EXCEPTION 'staff review required'; END IF;
  IF TG_OP='UPDATE' AND (NEW.reviewed_by_staff,NEW.review_note) IS DISTINCT FROM (OLD.reviewed_by_staff,OLD.review_note) AND NOT (NEW.reviewed_by_staff IS NULL AND NEW.review_note IS NULL AND (OLD.status IN('DRAFT','RETURNED') OR NEW.external_document_version_id IS DISTINCT FROM OLD.external_document_version_id)) THEN RAISE EXCEPTION 'staff review required'; END IF;
 END IF;
 RETURN NEW;
END $function$;
