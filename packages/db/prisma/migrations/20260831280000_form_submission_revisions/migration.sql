-- Fachkatalog: YEAR-END-CAMPAIGN-001, FORM-SCHEMA-SNAPSHOT-001, DOC-VERSION-IMMUTABILITY-001.
BEGIN;
CREATE TABLE form_submission_revision (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 submission_id UUID NOT NULL REFERENCES form_submission(id), sequence INTEGER NOT NULL CHECK(sequence>0),
 schema_snapshot JSONB NOT NULL, answers JSONB NOT NULL, submitted_at TIMESTAMP(3) NOT NULL,
 submitted_by_contact UUID, captured_by_staff UUID NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(submission_id,sequence), UNIQUE(submission_id,submitted_at)
);
CREATE TABLE form_submission_revision_file (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), revision_id UUID NOT NULL REFERENCES form_submission_revision(id) ON DELETE CASCADE,
 field_key TEXT NOT NULL, document_version_id UUID NOT NULL REFERENCES document_version(id), sha256 TEXT NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
 UNIQUE(revision_id,field_key)
);
CREATE FUNCTION app.form_revision_scope(sid UUID,write_access BOOLEAN DEFAULT false) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.form_submission s WHERE s.id=sid AND s.tenant_id=app.current_tenant_id() AND
 ((app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(s.tenant_id,app.current_actor_id(),s.client_id))
 OR (NOT write_access AND app.current_actor_type()='CLIENT_CONTACT' AND EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=app.current_actor_id() AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id AND c.active))));
$$;
REVOKE ALL ON FUNCTION app.form_revision_scope(UUID,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.form_revision_scope(UUID,BOOLEAN) TO taxtronik_app;
ALTER TABLE form_submission_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submission_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE form_submission_revision_file ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submission_revision_file FORCE ROW LEVEL SECURITY;
CREATE POLICY form_revision_read ON form_submission_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.form_revision_scope(submission_id));
CREATE POLICY form_revision_insert ON form_submission_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.form_revision_scope(submission_id,true));
CREATE POLICY form_revision_file_read ON form_submission_revision_file FOR SELECT USING(EXISTS(SELECT 1 FROM form_submission_revision r WHERE r.id=revision_id AND app.form_revision_scope(r.submission_id)));
CREATE POLICY form_revision_file_insert ON form_submission_revision_file FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM form_submission_revision r WHERE r.id=revision_id AND app.form_revision_scope(r.submission_id,true)));
GRANT SELECT,INSERT ON form_submission_revision,form_submission_revision_file TO taxtronik_app;
REVOKE UPDATE,DELETE ON form_submission_revision,form_submission_revision_file FROM taxtronik_app;
CREATE FUNCTION app.guard_form_submission_revision() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
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
END $$;
CREATE TRIGGER form_revision_immutable BEFORE INSERT OR UPDATE ON form_submission_revision FOR EACH ROW EXECUTE FUNCTION app.guard_form_submission_revision();
CREATE TRIGGER form_revision_file_immutable BEFORE INSERT OR UPDATE ON form_submission_revision_file FOR EACH ROW EXECUTE FUNCTION app.guard_form_submission_revision();
REVOKE ALL ON FUNCTION app.guard_form_submission_revision() FROM PUBLIC,taxtronik_app;
COMMIT;
