CREATE OR REPLACE FUNCTION app.guard_assistance_external_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF (NEW.external_document_version_id IS NULL)<>(NEW.external_document_hash IS NULL) THEN RAISE EXCEPTION 'incomplete external document'; END IF;
 IF NEW.external_document_version_id IS NOT NULL AND (NEW.kind<>'PROCEDURE' OR NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.external_document_version_id AND d.tenant_id=NEW.tenant_id AND d.client_id=NEW.client_id AND d.deleted_at IS NULL AND d.gwg_destroyed_at IS NULL AND d.gwg_destruction_requested_at IS NULL AND d.classification NOT IN('GWG_EVIDENCE','STAFF_PRIVATE','PERSONNEL') AND (to_jsonb(d)->>'requires_payroll_access') IS DISTINCT FROM 'true' AND d.mime_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL AND encode(v.sha256,'hex')=NEW.external_document_hash AND (app.current_actor_type()<>'CLIENT_CONTACT' OR d.shared_with_client_at IS NOT NULL))) THEN RAISE EXCEPTION 'invalid external Word version'; END IF;
 IF TG_OP='UPDATE' AND (NEW.external_document_version_id,NEW.external_document_hash) IS DISTINCT FROM (OLD.external_document_version_id,OLD.external_document_hash) THEN
  IF NEW.external_document_version_id IS NULL OR NEW.status<>'SUBMITTED' OR NEW.reviewed_by_staff IS NOT NULL OR NEW.review_note IS NOT NULL THEN RAISE EXCEPTION 'external Word requires fresh review'; END IF;
 END IF;
 RETURN NEW;
END $function$;
