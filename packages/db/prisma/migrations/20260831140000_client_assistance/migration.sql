-- CLIENT-ASSISTANCE-001: human reviewed, versioned source data; no tax acceptance assertion.
ALTER TYPE "staff_permission_name" ADD VALUE IF NOT EXISTS 'PAYROLL_MANAGE';
ALTER TYPE "staff_permission_name" ADD VALUE IF NOT EXISTS 'INBOUND_MAIL_MANAGE';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'SCREENING_REVIEW';
CREATE TABLE client_assistance_case (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 client_id UUID NOT NULL REFERENCES client(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 kind TEXT NOT NULL CHECK(kind IN ('BEWIRTUNG','EIGENBELEG','PROCEDURE')), title TEXT NOT NULL,
 schema_snapshot JSONB NOT NULL, answers JSONB NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','RETURNED','REVIEWED')),
 source_document_version_id UUID, source_hash TEXT, confirmed_at TIMESTAMP(3),
 submitted_by_contact UUID, reviewed_by_staff UUID, review_note TEXT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX client_assistance_case_tenant_id_client_id_idx ON client_assistance_case(tenant_id,client_id);
CREATE TABLE client_assistance_revision (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), case_id UUID NOT NULL REFERENCES client_assistance_case(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 revision INTEGER NOT NULL, answers JSONB NOT NULL, status TEXT NOT NULL,
 actor_id UUID NOT NULL, actor_type TEXT NOT NULL, occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX client_assistance_revision_case_id_revision_key ON client_assistance_revision(case_id,revision);
ALTER TABLE client_assistance_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assistance_case FORCE ROW LEVEL SECURITY;
CREATE POLICY assistance_case_access ON client_assistance_case USING (
 tenant_id=app.current_tenant_id() AND (
 (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))
 OR (app.current_actor_type()='CLIENT_CONTACT' AND EXISTS(SELECT 1 FROM client_contact cc JOIN client c ON c.id=cc.client_id WHERE cc.id=app.current_actor_id() AND cc.tenant_id=client_assistance_case.tenant_id AND cc.client_id=client_assistance_case.client_id AND cc.active AND c.mandate_ended_at IS NULL AND c.allow_active AND c.anonymized_at IS NULL))
 )) WITH CHECK (
 tenant_id=app.current_tenant_id() AND (
 (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))
 OR (app.current_actor_type()='CLIENT_CONTACT' AND EXISTS(SELECT 1 FROM client_contact cc JOIN client c ON c.id=cc.client_id WHERE cc.id=app.current_actor_id() AND cc.tenant_id=client_assistance_case.tenant_id AND cc.client_id=client_assistance_case.client_id AND cc.active AND c.mandate_ended_at IS NULL AND c.allow_active AND c.anonymized_at IS NULL))
 ));
ALTER TABLE client_assistance_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_assistance_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY assistance_revision_read ON client_assistance_revision FOR SELECT USING (EXISTS(SELECT 1 FROM client_assistance_case c WHERE c.id=case_id));
CREATE POLICY assistance_revision_insert ON client_assistance_revision FOR INSERT WITH CHECK (EXISTS(SELECT 1 FROM client_assistance_case c WHERE c.id=case_id));
GRANT SELECT,INSERT,UPDATE ON client_assistance_case TO taxtronik_app;
GRANT SELECT,INSERT ON client_assistance_revision TO taxtronik_app;
CREATE FUNCTION app.guard_assistance_case() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'tenant/client mismatch'; END IF;
 IF NEW.source_document_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.document_version v JOIN public.document d ON d.id=v.document_id WHERE v.id=NEW.source_document_version_id AND d.tenant_id=NEW.tenant_id AND d.client_id=NEW.client_id AND d.deleted_at IS NULL AND v.scan_status='CLEAN' AND encode(v.sha256,'hex')=NEW.source_hash) THEN RAISE EXCEPTION 'invalid original document'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.tenant_id,NEW.client_id,NEW.kind,NEW.schema_snapshot) IS DISTINCT FROM (OLD.tenant_id,OLD.client_id,OLD.kind,OLD.schema_snapshot) THEN RAISE EXCEPTION 'immutable template snapshot'; END IF;
  IF (OLD.source_document_version_id IS NOT NULL OR OLD.status<>'DRAFT') AND (NEW.source_document_version_id,NEW.source_hash) IS DISTINCT FROM (OLD.source_document_version_id,OLD.source_hash) THEN RAISE EXCEPTION 'immutable original snapshot'; END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'invalid revision'; END IF;
  IF OLD.status NOT IN ('DRAFT','RETURNED') AND NEW.answers IS DISTINCT FROM OLD.answers THEN RAISE EXCEPTION 'submitted answers are immutable'; END IF;
 END IF;
 IF app.current_actor_type()='CLIENT_CONTACT' THEN
  IF NEW.status NOT IN ('DRAFT','SUBMITTED') THEN RAISE EXCEPTION 'staff review required'; END IF;
  IF TG_OP='INSERT' AND NEW.reviewed_by_staff IS NOT NULL THEN RAISE EXCEPTION 'staff review required'; END IF;
  IF TG_OP='UPDATE' AND (NEW.reviewed_by_staff,NEW.review_note) IS DISTINCT FROM (OLD.reviewed_by_staff,OLD.review_note) THEN RAISE EXCEPTION 'staff review required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER assistance_case_guard BEFORE INSERT OR UPDATE ON client_assistance_case FOR EACH ROW EXECUTE FUNCTION app.guard_assistance_case();
CREATE FUNCTION app.assistance_history_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'assistance history is append only'; END $$;
CREATE TRIGGER assistance_history_immutable BEFORE UPDATE OR DELETE ON client_assistance_revision FOR EACH ROW EXECUTE FUNCTION app.assistance_history_append_only();
