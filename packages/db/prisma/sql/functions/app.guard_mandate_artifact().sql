CREATE OR REPLACE FUNCTION app.guard_mandate_artifact()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.document_version_id IS DISTINCT FROM OLD.document_version_id OR NEW.document_id IS DISTINCT FROM OLD.document_id) AND pg_trigger_depth()>1 AND (NEW.document_version_id IS NULL OR NEW.document_id IS NULL) AND (to_jsonb(NEW)-'document_version_id'-'document_id')=(to_jsonb(OLD)-'document_version_id'-'document_id') THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id AND anonymized_at IS NULL) THEN RAISE EXCEPTION 'invalid artifact mandate'; END IF;
 IF NEW.structure_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mandate_structure_version WHERE id=NEW.structure_version_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id) THEN RAISE EXCEPTION 'invalid structure artifact'; END IF;
 IF NEW.offboarding_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mandate_offboarding WHERE id=NEW.offboarding_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND length(recipient)>=10) THEN RAISE EXCEPTION 'invalid handover artifact'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'status'-'document_id'-'document_version_id'-'output_hash'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'document_id'-'document_version_id'-'output_hash'-'completed_at') THEN RAISE EXCEPTION 'immutable artifact identity'; END IF;
  IF NOT ((OLD.status='RESERVED' AND NEW.status='PENDING') OR (OLD.status='PENDING' AND NEW.status='READY' AND NEW.document_id=OLD.document_id AND NEW.document_version_id=OLD.document_version_id AND NEW.output_hash=OLD.output_hash)) THEN RAISE EXCEPTION 'invalid artifact transition'; END IF;
 END IF;
 IF NEW.document_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.document_version_id AND d.id=NEW.document_id AND d.tenant_id=NEW.tenant_id AND d.client_id=NEW.client_id AND d.classification::text=NEW.classification AND encode(v.sha256,'hex')=NEW.output_hash AND d.shared_with_client_at IS NULL AND ((to_jsonb(d)->>'requires_payroll_access')::boolean IS NOT DISTINCT FROM NEW.requires_payroll_access) AND (NEW.status<>'READY' OR (v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL))) THEN RAISE EXCEPTION 'invalid artifact document'; END IF;
 RETURN NEW;
END $function$;
