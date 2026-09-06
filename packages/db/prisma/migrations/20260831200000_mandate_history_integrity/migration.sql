-- Fachkatalog: MANDATE-STRUCTURE-001 / CLIENT-OFFBOARDING-001 / VDB-PREPARATION-001.
-- Default table grants must not make immutable histories mutable.
REVOKE UPDATE,DELETE ON mandate_structure_version,mandate_structure_node,mandate_structure_edge,vdb_record FROM taxtronik_app;
REVOKE DELETE ON mandate_offboarding,mandate_artifact FROM taxtronik_app;
REVOKE UPDATE,DELETE ON mandate_artifact_source FROM taxtronik_app;
CREATE FUNCTION app.guard_mandate_immutable_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'mandate history is immutable'; END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['mandate_structure_version','mandate_structure_node','mandate_structure_edge','vdb_record'] LOOP
  EXECUTE format('CREATE TRIGGER mandate_immutable_history BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_immutable_history()',t);
 END LOOP;
END $$;

-- Adding an extra source after bytes have been bound would invalidate the manifest.
CREATE FUNCTION app.guard_mandate_source_reservation() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM mandate_artifact WHERE id=NEW.artifact_id AND status='RESERVED' AND document_id IS NULL AND document_version_id IS NULL) THEN RAISE EXCEPTION 'artifact sources must be bound before upload'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mandate_source_reservation BEFORE INSERT ON mandate_artifact_source FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_source_reservation();

-- Generic document delivery must keep the same source availability and protection checks.
CREATE FUNCTION app.mandate_artifact_sources_valid(aid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.id=aid AND a.tenant_id=app.current_tenant_id() AND
  (a.kind='STRUCTURE' OR (a.kind='OFFBOARDING' AND jsonb_typeof(a.manifest->'snapshot'->'documents')='array'
   AND jsonb_array_length(a.manifest->'snapshot'->'documents')=(SELECT count(*) FROM mandate_artifact_source s WHERE s.artifact_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.manifest->'snapshot'->'documents') expected WHERE NOT EXISTS(
    SELECT 1 FROM mandate_artifact_source s JOIN document_version v ON v.id=s.document_version_id JOIN document d ON d.id=v.document_id
    WHERE s.artifact_id=a.id AND v.id::text=expected->>'versionId' AND d.id::text=expected->>'documentId'
    AND d.tenant_id=a.tenant_id AND d.client_id=a.client_id AND encode(v.sha256,'hex')=s.source_hash AND s.source_hash=expected->>'sha256'
    AND d.classification::text=expected->>'classification' AND d.requires_payroll_access::text=expected->>'requiresPayrollAccess'
    AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL AND d.deleted_at IS NULL AND d.gwg_destroyed_at IS NULL AND d.gwg_destruction_requested_at IS NULL
   )))))
$$;
REVOKE ALL ON FUNCTION app.mandate_artifact_sources_valid(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mandate_artifact_sources_valid(UUID) TO taxtronik_app;
CREATE OR REPLACE FUNCTION app.mandate_artifact_document_allowed(tid UUID,did TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT tid=app.current_tenant_id() AND (NOT EXISTS(SELECT 1 FROM mandate_artifact WHERE tenant_id=tid AND document_id::text=did)
 OR EXISTS(SELECT 1 FROM mandate_artifact WHERE tenant_id=tid AND document_id::text=did AND app.mandate_artifact_allowed(id) AND app.mandate_artifact_sources_valid(id)))
$$;
CREATE FUNCTION app.guard_mandate_artifact_document() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.document_id=OLD.id AND (a.classification IS DISTINCT FROM NEW.classification::text OR a.requires_payroll_access IS DISTINCT FROM NEW.requires_payroll_access OR NEW.shared_with_client_at IS NOT NULL OR NEW.mime_type IS DISTINCT FROM OLD.mime_type)) THEN RAISE EXCEPTION 'artifact protection and private delivery are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mandate_artifact_document_guard BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact_document();
