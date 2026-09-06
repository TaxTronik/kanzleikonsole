-- Fachkatalog: MANDATE-STRUCTURE-001 / CLIENT-OFFBOARDING-001 / DOC-UPLOAD-JOURNAL-001.
-- Existing workflow reads remain tenant-RLS scoped; trigger joins require explicit SELECT.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.workflow_instance'::regclass AND relrowsecurity AND relforcerowsecurity) OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.workflow_item'::regclass AND relrowsecurity AND relforcerowsecurity) THEN RAISE EXCEPTION 'Workflow RLS must be enforced before dependency reads'; END IF;
END $$;
GRANT SELECT ON workflow_instance,workflow_item TO taxtronik_app;
ALTER TABLE mandate_offboarding ADD COLUMN recipient TEXT NOT NULL DEFAULT '';
ALTER TABLE mandate_offboarding_document ALTER COLUMN document_version_id DROP NOT NULL,
 DROP CONSTRAINT mandate_offboarding_document_document_version_id_fkey,
 ADD CONSTRAINT mandate_offboarding_document_document_version_id_fkey FOREIGN KEY(document_version_id) REFERENCES document_version(id) ON DELETE SET NULL ON UPDATE CASCADE,
 ADD COLUMN approved_by UUID REFERENCES staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 ADD COLUMN approved_at TIMESTAMPTZ(6), ADD COLUMN sensitive_approved BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE mandate_artifact (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 client_id UUID NOT NULL REFERENCES client(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 structure_version_id UUID REFERENCES mandate_structure_version(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 offboarding_id UUID REFERENCES mandate_offboarding(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 source_key TEXT NOT NULL, source_hash TEXT NOT NULL, generator_version TEXT NOT NULL, manifest JSONB NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('STRUCTURE','OFFBOARDING')), group_key TEXT NOT NULL, classification TEXT NOT NULL,
 requires_payroll_access BOOLEAN NOT NULL DEFAULT FALSE,
 document_id UUID REFERENCES document(id) ON DELETE SET NULL ON UPDATE CASCADE,
 document_version_id UUID REFERENCES document_version(id) ON DELETE SET NULL ON UPDATE CASCADE,
 output_hash TEXT, status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN('RESERVED','PENDING','READY')),
 created_by UUID NOT NULL REFERENCES staff_user(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMPTZ(6),
 CHECK((kind='STRUCTURE' AND structure_version_id IS NOT NULL AND offboarding_id IS NULL) OR (kind='OFFBOARDING' AND offboarding_id IS NOT NULL AND structure_version_id IS NULL))
);
CREATE UNIQUE INDEX mandate_artifact_tenant_id_source_key_generator_version_key ON mandate_artifact(tenant_id,source_key,generator_version);
CREATE UNIQUE INDEX mandate_artifact_document_id_key ON mandate_artifact(document_id);
CREATE UNIQUE INDEX mandate_artifact_document_version_id_key ON mandate_artifact(document_version_id);
CREATE TABLE mandate_artifact_source (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), artifact_id UUID NOT NULL REFERENCES mandate_artifact(id) ON DELETE NO ACTION ON UPDATE CASCADE,
 document_version_id UUID REFERENCES document_version(id) ON DELETE SET NULL ON UPDATE CASCADE, source_hash TEXT NOT NULL
);
CREATE UNIQUE INDEX mandate_artifact_source_artifact_id_document_version_id_key ON mandate_artifact_source(artifact_id,document_version_id);

CREATE FUNCTION app.mandate_artifact_row_allowed(tid UUID,cid UUID,akind TEXT,svid UUID,payroll BOOLEAN) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM client c WHERE c.id=cid AND tid=app.current_tenant_id() AND c.tenant_id=tid AND c.anonymized_at IS NULL AND (
 app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid)
 AND (NOT payroll OR app.expansion_staff_permission(tid,app.current_actor_id(),'PAYROLL_MANAGE'))
 AND ((akind='OFFBOARDING' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=tid AND s.active AND r.role IN('ADMIN','PARTNER')))
 OR (akind='STRUCTURE' AND NOT EXISTS(SELECT 1 FROM mandate_structure_node n LEFT JOIN client linked ON linked.id=n.linked_client_id WHERE n.version_id=svid AND n.linked_client_id IS NOT NULL AND (linked.anonymized_at IS NOT NULL OR NOT app.notification_staff_can_access_client(tid,app.current_actor_id(),n.linked_client_id))))))))
$$;
REVOKE ALL ON FUNCTION app.mandate_artifact_row_allowed(UUID,UUID,TEXT,UUID,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mandate_artifact_row_allowed(UUID,UUID,TEXT,UUID,BOOLEAN) TO taxtronik_app;
CREATE FUNCTION app.mandate_artifact_allowed(aid UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM mandate_artifact a WHERE a.id=aid AND app.mandate_artifact_row_allowed(a.tenant_id,a.client_id,a.kind,a.structure_version_id,a.requires_payroll_access))
$$;
REVOKE ALL ON FUNCTION app.mandate_artifact_allowed(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mandate_artifact_allowed(UUID) TO taxtronik_app;
ALTER TABLE mandate_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE mandate_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY mandate_artifact_read ON mandate_artifact FOR SELECT USING(app.mandate_artifact_row_allowed(tenant_id,client_id,kind,structure_version_id,requires_payroll_access));
CREATE POLICY mandate_artifact_insert ON mandate_artifact FOR INSERT WITH CHECK(app.current_actor_type()='STAFF' AND created_by=app.current_actor_id() AND app.mandate_artifact_row_allowed(tenant_id,client_id,kind,structure_version_id,requires_payroll_access));
CREATE POLICY mandate_artifact_update ON mandate_artifact FOR UPDATE USING(app.mandate_artifact_row_allowed(tenant_id,client_id,kind,structure_version_id,requires_payroll_access)) WITH CHECK(tenant_id=app.current_tenant_id());
ALTER TABLE mandate_artifact_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE mandate_artifact_source FORCE ROW LEVEL SECURITY;
CREATE POLICY mandate_artifact_source_scope ON mandate_artifact_source USING(app.mandate_artifact_allowed(artifact_id)) WITH CHECK(app.mandate_artifact_allowed(artifact_id));
GRANT SELECT,INSERT,UPDATE ON mandate_artifact TO taxtronik_app;
GRANT SELECT,INSERT ON mandate_artifact_source TO taxtronik_app;

CREATE FUNCTION app.mandate_artifact_document_allowed(tid UUID,did TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT tid=app.current_tenant_id() AND (NOT EXISTS(SELECT 1 FROM mandate_artifact WHERE tenant_id=tid AND document_id::text=did) OR EXISTS(SELECT 1 FROM mandate_artifact WHERE tenant_id=tid AND document_id::text=did AND app.mandate_artifact_allowed(id)))
$$;
REVOKE ALL ON FUNCTION app.mandate_artifact_document_allowed(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mandate_artifact_document_allowed(UUID,TEXT) TO taxtronik_app;
CREATE POLICY document_mandate_artifact_scope ON document AS RESTRICTIVE FOR ALL USING(app.mandate_artifact_document_allowed(tenant_id,id::text)) WITH CHECK(app.mandate_artifact_document_allowed(tenant_id,id::text));
CREATE POLICY notification_mandate_artifact_scope ON notification AS RESTRICTIVE FOR ALL USING(resource_type IS DISTINCT FROM 'document' OR app.mandate_artifact_document_allowed(tenant_id,resource_id)) WITH CHECK(resource_type IS DISTINCT FROM 'document' OR app.mandate_artifact_document_allowed(tenant_id,resource_id));

CREATE FUNCTION app.guard_mandate_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
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
END $$;
CREATE TRIGGER mandate_artifact_guard BEFORE INSERT OR UPDATE ON mandate_artifact FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact();
CREATE FUNCTION app.guard_mandate_artifact_source() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND NEW.document_version_id IS NULL AND OLD.document_version_id IS NOT NULL AND (to_jsonb(NEW)-'document_version_id')=(to_jsonb(OLD)-'document_version_id') THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable artifact source'; END IF;
 IF NOT EXISTS(SELECT 1 FROM mandate_artifact a JOIN document_version v ON v.id=NEW.document_version_id JOIN document d ON d.id=v.document_id WHERE a.id=NEW.artifact_id AND a.tenant_id=d.tenant_id AND a.client_id=d.client_id AND encode(v.sha256,'hex')=NEW.source_hash) THEN RAISE EXCEPTION 'invalid artifact source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mandate_artifact_source_guard BEFORE INSERT OR UPDATE OR DELETE ON mandate_artifact_source FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_artifact_source();

-- Existing mandate scope trigger also permits only FK-driven detachment during GwG destruction.
CREATE OR REPLACE FUNCTION app.mandate_expansion_scope() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
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
END $$;
CREATE FUNCTION app.guard_mandate_release() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
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
END $$;
CREATE TRIGGER mandate_release_guard BEFORE INSERT OR UPDATE OR DELETE ON mandate_offboarding_document FOR EACH ROW EXECUTE FUNCTION app.guard_mandate_release();
CREATE FUNCTION app.guard_completed_handover() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.completed_at IS NOT NULL OR (NEW.tenant_id,NEW.client_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.client_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'handover identity or completed state is immutable'; END IF;
 IF NEW.completed_at IS NOT NULL AND (to_jsonb(NEW)-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at') THEN RAISE EXCEPTION 'completion cannot replace the reviewed source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER completed_handover_guard BEFORE UPDATE ON mandate_offboarding FOR EACH ROW EXECUTE FUNCTION app.guard_completed_handover();
