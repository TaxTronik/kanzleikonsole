-- CLIENT-ASSISTANCE-001 / DOC-UPLOAD-JOURNAL-001. No history is invented for legacy rows.
ALTER TABLE client_assistance_case ADD COLUMN external_document_version_id UUID,
 ADD COLUMN external_document_hash TEXT,
 ADD CONSTRAINT client_assistance_case_source_document_version_id_fkey FOREIGN KEY(source_document_version_id) REFERENCES document_version(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 ADD CONSTRAINT client_assistance_case_external_document_version_id_fkey FOREIGN KEY(external_document_version_id) REFERENCES document_version(id) ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE client_assistance_revision ADD COLUMN snapshot JSONB NOT NULL DEFAULT '{}', ADD COLUMN snapshot_hash TEXT NOT NULL DEFAULT '',
 ADD COLUMN source_version_id UUID REFERENCES document_version(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 ADD COLUMN external_version_id UUID REFERENCES document_version(id) ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE client_assistance_output (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), revision_id UUID NOT NULL REFERENCES client_assistance_revision(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 format TEXT NOT NULL CHECK(format IN('pdf','docx','merged')), generator_version TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL, manifest JSONB NOT NULL,
 document_version_id UUID REFERENCES document_version(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 output_hash TEXT, status TEXT NOT NULL DEFAULT 'RESERVED' CHECK(status IN('RESERVED','PENDING','READY')),
 created_by UUID NOT NULL, actor_type TEXT NOT NULL CHECK(actor_type IN('STAFF','CLIENT_CONTACT')),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP(3),
 CHECK((status='RESERVED' AND document_version_id IS NULL AND output_hash IS NULL AND completed_at IS NULL) OR
       (status='PENDING' AND document_version_id IS NOT NULL AND output_hash IS NOT NULL AND completed_at IS NULL) OR
       (status='READY' AND document_version_id IS NOT NULL AND output_hash IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX client_assistance_output_document_version_id_key ON client_assistance_output(document_version_id);
CREATE UNIQUE INDEX client_assistance_output_revision_id_format_generator_version_key ON client_assistance_output(revision_id,format,generator_version);
ALTER TABLE client_assistance_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assistance_output FORCE ROW LEVEL SECURITY;
CREATE POLICY assistance_output_scope ON client_assistance_output USING(EXISTS(SELECT 1 FROM client_assistance_revision r WHERE r.id=revision_id)) WITH CHECK(EXISTS(SELECT 1 FROM client_assistance_revision r WHERE r.id=revision_id));
GRANT SELECT,INSERT,UPDATE ON client_assistance_output TO taxtronik_app;

CREATE FUNCTION app.guard_assistance_output() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE c RECORD; r RECORD;
BEGIN
 SELECT * INTO r FROM client_assistance_revision WHERE id=NEW.revision_id;
 SELECT * INTO c FROM client_assistance_case WHERE id=r.case_id;
 IF c.id IS NULL OR NEW.snapshot_hash IS DISTINCT FROM r.snapshot_hash OR r.snapshot_hash='' THEN RAISE EXCEPTION 'invalid output snapshot'; END IF;
 IF TG_OP='INSERT' AND (NEW.created_by IS DISTINCT FROM app.current_actor_id() OR NEW.actor_type IS DISTINCT FROM app.current_actor_type()) THEN RAISE EXCEPTION 'invalid output actor'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.revision_id,NEW.format,NEW.generator_version,NEW.snapshot_hash,NEW.manifest,NEW.created_by,NEW.actor_type,NEW.created_at) IS DISTINCT FROM (OLD.revision_id,OLD.format,OLD.generator_version,OLD.snapshot_hash,OLD.manifest,OLD.created_by,OLD.actor_type,OLD.created_at) THEN RAISE EXCEPTION 'immutable output identity'; END IF;
  IF OLD.status='READY' OR (OLD.status='PENDING' AND (NEW.document_version_id,NEW.output_hash) IS DISTINCT FROM (OLD.document_version_id,OLD.output_hash)) OR NOT ((OLD.status='RESERVED' AND NEW.status='PENDING') OR (OLD.status='PENDING' AND NEW.status='READY')) THEN RAISE EXCEPTION 'invalid output transition'; END IF;
 END IF;
 IF NEW.document_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.document_version_id AND d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND encode(v.sha256,'hex')=NEW.output_hash AND (NEW.status<>'READY' OR (v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL))) THEN RAISE EXCEPTION 'invalid output document'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_output_guard BEFORE INSERT OR UPDATE ON client_assistance_output FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_output();

CREATE FUNCTION app.guard_assistance_revision_snapshot() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE c RECORD;
BEGIN
 SELECT * INTO c FROM client_assistance_case WHERE id=NEW.case_id;
 IF c.id IS NULL OR NEW.revision<>c.revision OR NEW.answers IS DISTINCT FROM c.answers OR NEW.status<>c.status OR NEW.actor_id IS DISTINCT FROM app.current_actor_id() OR NEW.actor_type IS DISTINCT FROM app.current_actor_type() THEN RAISE EXCEPTION 'invalid revision event'; END IF;
 IF NEW.snapshot_hash !~ '^[0-9a-f]{64}$' OR NEW.snapshot->>'caseId' IS DISTINCT FROM c.id::text OR NEW.snapshot->>'kind' IS DISTINCT FROM c.kind OR NEW.snapshot->>'status' IS DISTINCT FROM c.status OR (NEW.snapshot->>'revision')::integer IS DISTINCT FROM c.revision OR NEW.snapshot->'answers' IS DISTINCT FROM c.answers OR NEW.snapshot->'schema' IS DISTINCT FROM c.schema_snapshot THEN RAISE EXCEPTION 'invalid revision snapshot'; END IF;
 IF NEW.source_version_id IS DISTINCT FROM c.source_document_version_id OR NEW.external_version_id IS DISTINCT FROM c.external_document_version_id OR NEW.snapshot->>'sourceVersionId' IS DISTINCT FROM c.source_document_version_id::text OR NEW.snapshot->>'sourceHash' IS DISTINCT FROM c.source_hash OR NEW.snapshot->>'externalVersionId' IS DISTINCT FROM c.external_document_version_id::text OR NEW.snapshot->>'externalHash' IS DISTINCT FROM c.external_document_hash THEN RAISE EXCEPTION 'invalid source snapshot'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_revision_snapshot_guard BEFORE INSERT ON client_assistance_revision FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_revision_snapshot();

CREATE FUNCTION app.guard_assistance_external_version() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF (NEW.external_document_version_id IS NULL)<>(NEW.external_document_hash IS NULL) THEN RAISE EXCEPTION 'incomplete external document'; END IF;
 IF NEW.external_document_version_id IS NOT NULL AND (NEW.kind<>'PROCEDURE' OR NOT EXISTS(SELECT 1 FROM document_version v JOIN document d ON d.id=v.document_id WHERE v.id=NEW.external_document_version_id AND d.tenant_id=NEW.tenant_id AND d.client_id=NEW.client_id AND d.deleted_at IS NULL AND d.gwg_destroyed_at IS NULL AND d.gwg_destruction_requested_at IS NULL AND d.classification NOT IN('GWG_EVIDENCE','STAFF_PRIVATE','PERSONNEL') AND (to_jsonb(d)->>'requires_payroll_access') IS DISTINCT FROM 'true' AND d.mime_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND v.scan_status='CLEAN' AND v.scan_completed_at IS NOT NULL AND encode(v.sha256,'hex')=NEW.external_document_hash AND (app.current_actor_type()<>'CLIENT_CONTACT' OR d.shared_with_client_at IS NOT NULL))) THEN RAISE EXCEPTION 'invalid external Word version'; END IF;
 IF TG_OP='UPDATE' AND (NEW.external_document_version_id,NEW.external_document_hash) IS DISTINCT FROM (OLD.external_document_version_id,OLD.external_document_hash) THEN
  IF NEW.external_document_version_id IS NULL OR NEW.status<>'SUBMITTED' OR NEW.reviewed_by_staff IS NOT NULL OR NEW.review_note IS NOT NULL THEN RAISE EXCEPTION 'external Word requires fresh review'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_external_version_guard BEFORE INSERT OR UPDATE ON client_assistance_case FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_external_version();

-- Preserve the original scope/template guards; clear a former review only for a new input revision.
CREATE OR REPLACE FUNCTION app.guard_assistance_case() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
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
END $$;
