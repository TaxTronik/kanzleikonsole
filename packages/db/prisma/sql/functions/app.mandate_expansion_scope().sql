CREATE OR REPLACE FUNCTION app.mandate_expansion_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
DECLARE scope_client UUID; scope_tenant UUID;
BEGIN
 IF TG_TABLE_NAME='mandate_offboarding_document' THEN
  IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND NEW.document_version_id IS NULL AND OLD.document_version_id IS NOT NULL AND (to_jsonb(NEW)-'document_version_id')=(to_jsonb(OLD)-'document_version_id') THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME IN('mandate_structure_version','mandate_offboarding','vdb_record') THEN
  IF NOT EXISTS(SELECT 1 FROM client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id AND anonymized_at IS NULL) OR NOT EXISTS(SELECT 1 FROM staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid mandate or actor scope'; END IF;
 ELSIF TG_TABLE_NAME='mandate_structure_node' THEN
  IF NOT EXISTS(SELECT 1 FROM mandate_structure_version WHERE id=NEW.version_id AND tenant_id=NEW.tenant_id) OR (NEW.linked_client_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM client WHERE id=NEW.linked_client_id AND tenant_id=NEW.tenant_id AND anonymized_at IS NULL)) THEN RAISE EXCEPTION 'Invalid structure scope'; END IF;
 ELSIF TG_TABLE_NAME='mandate_structure_edge' THEN
  IF NOT EXISTS(SELECT 1 FROM mandate_structure_node a JOIN mandate_structure_node b ON b.id=NEW.to_node_id WHERE a.id=NEW.from_node_id AND a.version_id=NEW.version_id AND b.version_id=NEW.version_id AND a.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid structure endpoints'; END IF;
 ELSIF TG_TABLE_NAME='mandate_offboarding_document' THEN
  SELECT client_id,tenant_id INTO scope_client,scope_tenant FROM mandate_offboarding WHERE id=NEW.offboarding_id;
  IF scope_tenant IS DISTINCT FROM NEW.tenant_id OR NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.document_version_id AND d.client_id=scope_client AND d.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid handover evidence'; END IF;
 END IF;
 IF TG_TABLE_NAME='vdb_record' THEN
  IF NOT EXISTS(SELECT 1 FROM power_of_attorney WHERE id=NEW.poa_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id) OR (NEW.evidence_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.evidence_version_id AND d.client_id=NEW.client_id AND d.tenant_id=NEW.tenant_id)) THEN RAISE EXCEPTION 'Invalid VDB evidence'; END IF;
 END IF;
 RETURN NEW;
END $function$;
