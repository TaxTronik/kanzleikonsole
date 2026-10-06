CREATE OR REPLACE FUNCTION app.guard_mandate_release()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE run RECORD; d RECORD;
BEGIN
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND NEW.document_version_id IS NULL AND OLD.document_version_id IS NOT NULL AND (to_jsonb(NEW)-'document_version_id')=(to_jsonb(OLD)-'document_version_id') THEN RETURN NEW; END IF;
 SELECT * INTO run FROM mandate_offboarding WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.offboarding_id ELSE NEW.offboarding_id END FOR UPDATE;
 IF run.completed_at IS NOT NULL THEN RAISE EXCEPTION 'completed handover is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.approved_by IS DISTINCT FROM app.current_actor_id() OR NEW.approved_at IS NULL OR length(run.recipient)<10 OR NOT EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=NEW.approved_by AND s.tenant_id=NEW.tenant_id AND s.active AND r.role IN('ADMIN','PARTNER')) THEN RAISE EXCEPTION 'explicit staff release required'; END IF;
 SELECT doc.* INTO d FROM document_version v JOIN document doc ON doc.id=v.document_id WHERE v.id=NEW.document_version_id AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.gwg_destroyed_at IS NOT NULL OR d.gwg_destruction_requested_at IS NOT NULL THEN RAISE EXCEPTION 'release document unavailable'; END IF;
 IF (d.classification IN('GWG_EVIDENCE','PERSONNEL','STAFF_PRIVATE') OR (to_jsonb(d)->>'requires_payroll_access')='true') AND NOT NEW.sensitive_approved THEN RAISE EXCEPTION 'additional sensitive release required'; END IF;
 IF (d.classification='PERSONNEL' OR (to_jsonb(d)->>'requires_payroll_access')='true') AND NOT app.expansion_staff_permission(NEW.tenant_id,NEW.approved_by,'PAYROLL_MANAGE') THEN RAISE EXCEPTION 'payroll access required'; END IF;
 RETURN NEW;
END $function$;
