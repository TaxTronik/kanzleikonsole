-- GWG-SCREENING-001 / STBVV-CALCULATION-001. No changes to GwG approval.
BEGIN;
CREATE TABLE sanctions_snapshot (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
 sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), source_url TEXT NOT NULL,
 source_version TEXT NOT NULL, published_at TIMESTAMPTZ(6) NOT NULL,
 imported_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 entries JSONB NOT NULL, entry_count INTEGER NOT NULL CHECK (entry_count > 0),
 CONSTRAINT sanctions_snapshot_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX sanctions_snapshot_tenant_id_sha256_key ON sanctions_snapshot(tenant_id,sha256);
CREATE UNIQUE INDEX sanctions_snapshot_tenant_id_id_key ON sanctions_snapshot(tenant_id,id);
CREATE TABLE sanctions_source_state (
 tenant_id UUID PRIMARY KEY, snapshot_id UUID, checked_at TIMESTAMPTZ(6), attempted_at TIMESTAMPTZ(6), last_error TEXT,
 CONSTRAINT sanctions_source_state_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT sanctions_source_state_tenant_id_snapshot_id_fkey FOREIGN KEY (tenant_id,snapshot_id) REFERENCES sanctions_snapshot(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE TABLE screening_run (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, client_id UUID NOT NULL,
 snapshot_id UUID, previous_run_id UUID, kind TEXT NOT NULL CHECK (kind IN ('EU','PEP')),
 subject JSONB NOT NULL, result JSONB NOT NULL, created_by UUID, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT screening_run_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT screening_run_tenant_id_client_id_fkey FOREIGN KEY (tenant_id,client_id) REFERENCES client(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT screening_run_tenant_id_snapshot_id_fkey FOREIGN KEY (tenant_id,snapshot_id) REFERENCES sanctions_snapshot(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT screening_run_source_check CHECK ((kind='EU' AND snapshot_id IS NOT NULL) OR (kind='PEP' AND snapshot_id IS NULL))
);
CREATE UNIQUE INDEX screening_run_tenant_id_client_id_id_key ON screening_run(tenant_id,client_id,id);
ALTER TABLE screening_run ADD CONSTRAINT screening_run_previous_run_fkey FOREIGN KEY (tenant_id,client_id,previous_run_id) REFERENCES screening_run(tenant_id,client_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE UNIQUE INDEX screening_run_previous_run_id_snapshot_id_key ON screening_run(previous_run_id,snapshot_id);
CREATE INDEX screening_run_tenant_id_client_id_created_at_idx ON screening_run(tenant_id,client_id,created_at);
CREATE TABLE screening_review (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, client_id UUID NOT NULL, run_id UUID NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('UNRESOLVED','FALSE_POSITIVE','CONFIRMED','PEP_FOUND','PEP_NOT_FOUND')),
 note TEXT NOT NULL CHECK (length(btrim(note)) >= 10), sources JSONB NOT NULL, created_by UUID NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT screening_review_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT screening_review_tenant_id_client_id_fkey FOREIGN KEY (tenant_id,client_id) REFERENCES client(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT screening_review_tenant_id_client_id_run_id_fkey FOREIGN KEY (tenant_id,client_id,run_id) REFERENCES screening_run(tenant_id,client_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX screening_review_tenant_id_client_id_run_id_idx ON screening_review(tenant_id,client_id,run_id);
CREATE TABLE stbvv_quote (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, client_id UUID NOT NULL,
 title TEXT NOT NULL, law_version TEXT NOT NULL, inputs JSONB NOT NULL, result JSONB NOT NULL,
 created_by UUID NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT stbvv_quote_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT stbvv_quote_tenant_id_client_id_fkey FOREIGN KEY (tenant_id,client_id) REFERENCES client(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX stbvv_quote_tenant_id_id_key ON stbvv_quote(tenant_id,id);
CREATE INDEX stbvv_quote_tenant_id_client_id_created_at_idx ON stbvv_quote(tenant_id,client_id,created_at);
CREATE TABLE stbvv_quote_export (
 quote_id UUID PRIMARY KEY, tenant_id UUID NOT NULL, invoice_id UUID NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT stbvv_quote_export_tenant_id_quote_id_fkey FOREIGN KEY (tenant_id,quote_id) REFERENCES stbvv_quote(tenant_id,id) ON DELETE NO ACTION ON UPDATE NO ACTION,
 CONSTRAINT stbvv_quote_export_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoice(id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX stbvv_quote_export_invoice_id_key ON stbvv_quote_export(invoice_id);
CREATE UNIQUE INDEX stbvv_quote_export_tenant_id_quote_id_key ON stbvv_quote_export(tenant_id,quote_id);
CREATE FUNCTION app.stbvv_export_same_client() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.stbvv_quote q JOIN public.invoice i ON i.id=NEW.invoice_id
   WHERE q.id=NEW.quote_id AND q.tenant_id=NEW.tenant_id
     AND i.tenant_id=q.tenant_id AND i.client_id=q.client_id
 ) THEN RAISE EXCEPTION 'Fee quote and invoice must belong to the same tenant and client'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER stbvv_export_same_client BEFORE INSERT ON stbvv_quote_export
 FOR EACH ROW EXECUTE FUNCTION app.stbvv_export_same_client();
CREATE FUNCTION app.screening_fees_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Immutable snapshot: append a new finding or calculation'; END; $$;

REVOKE ALL ON sanctions_snapshot FROM taxtronik_app;
ALTER TABLE sanctions_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY sanctions_snapshot_select ON sanctions_snapshot FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_actor_is_active(tenant_id,app.current_actor_id()))));
CREATE POLICY sanctions_snapshot_insert ON sanctions_snapshot FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=sanctions_snapshot.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER')))));
CREATE TRIGGER sanctions_snapshot_immutable BEFORE UPDATE OR DELETE ON sanctions_snapshot FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
GRANT SELECT,INSERT ON sanctions_snapshot TO taxtronik_app;

REVOKE ALL ON sanctions_source_state FROM taxtronik_app;
ALTER TABLE sanctions_source_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sanctions_source_state FORCE ROW LEVEL SECURITY;
CREATE POLICY sanctions_source_state_select ON sanctions_source_state FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_actor_is_active(tenant_id,app.current_actor_id()))));
CREATE POLICY sanctions_source_state_insert ON sanctions_source_state FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=sanctions_source_state.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER')))));
CREATE POLICY sanctions_source_state_update ON sanctions_source_state FOR UPDATE USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=sanctions_source_state.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER'))))) WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND EXISTS(SELECT 1 FROM staff_user s JOIN staff_role r ON r.staff_user_id=s.id WHERE s.id=app.current_actor_id() AND s.tenant_id=sanctions_source_state.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER')))));
GRANT SELECT,INSERT,UPDATE ON sanctions_source_state TO taxtronik_app;

REVOKE ALL ON screening_run FROM taxtronik_app;
ALTER TABLE screening_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_run FORCE ROW LEVEL SECURITY;
CREATE POLICY screening_run_select ON screening_run FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))));
CREATE POLICY screening_run_insert ON screening_run FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))) AND ((app.current_actor_type()='SYSTEM' AND created_by IS NULL) OR (app.current_actor_type()='STAFF' AND created_by=app.current_actor_id())));
CREATE TRIGGER screening_run_immutable BEFORE UPDATE OR DELETE ON screening_run FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
GRANT SELECT,INSERT ON screening_run TO taxtronik_app;

REVOKE ALL ON screening_review FROM taxtronik_app;
ALTER TABLE screening_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE screening_review FORCE ROW LEVEL SECURITY;
CREATE POLICY screening_review_select ON screening_review FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))));
CREATE POLICY screening_review_insert ON screening_review FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id)) AND created_by=app.current_actor_id());
CREATE TRIGGER screening_review_immutable BEFORE UPDATE OR DELETE ON screening_review FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
GRANT SELECT,INSERT ON screening_review TO taxtronik_app;

REVOKE ALL ON stbvv_quote FROM taxtronik_app;
ALTER TABLE stbvv_quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE stbvv_quote FORCE ROW LEVEL SECURITY;
CREATE POLICY stbvv_quote_select ON stbvv_quote FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id))));
CREATE POLICY stbvv_quote_insert ON stbvv_quote FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id)) AND created_by=app.current_actor_id());
CREATE TRIGGER stbvv_quote_immutable BEFORE UPDATE OR DELETE ON stbvv_quote FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
CREATE POLICY stbvv_quote_invoice_permission ON stbvv_quote AS RESTRICTIVE FOR INSERT WITH CHECK (
 EXISTS (SELECT 1 FROM staff_user s WHERE s.id=app.current_actor_id() AND s.tenant_id=stbvv_quote.tenant_id AND s.active AND (
   EXISTS (SELECT 1 FROM staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER'))
   OR EXISTS (SELECT 1 FROM staff_permission p WHERE p.staff_user_id=s.id AND p.permission='INVOICE_MANAGE')
 ))
);
GRANT SELECT,INSERT ON stbvv_quote TO taxtronik_app;

REVOKE ALL ON stbvv_quote_export FROM taxtronik_app;
ALTER TABLE stbvv_quote_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE stbvv_quote_export FORCE ROW LEVEL SECURITY;
CREATE POLICY stbvv_quote_export_select ON stbvv_quote_export FOR SELECT USING (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='SYSTEM' OR (app.current_actor_type()='STAFF' AND EXISTS (SELECT 1 FROM stbvv_quote q JOIN invoice i ON i.id=stbvv_quote_export.invoice_id WHERE q.id=stbvv_quote_export.quote_id AND q.tenant_id=stbvv_quote_export.tenant_id AND i.tenant_id=q.tenant_id AND i.client_id=q.client_id))));
CREATE POLICY stbvv_quote_export_insert ON stbvv_quote_export FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id() AND (app.current_actor_type()='STAFF' AND EXISTS (SELECT 1 FROM stbvv_quote q JOIN invoice i ON i.id=stbvv_quote_export.invoice_id WHERE q.id=stbvv_quote_export.quote_id AND q.tenant_id=stbvv_quote_export.tenant_id AND i.tenant_id=q.tenant_id AND i.client_id=q.client_id)));
CREATE TRIGGER stbvv_quote_export_immutable BEFORE UPDATE OR DELETE ON stbvv_quote_export FOR EACH ROW EXECUTE FUNCTION app.screening_fees_immutable();
CREATE POLICY stbvv_quote_export_invoice_permission ON stbvv_quote_export AS RESTRICTIVE FOR INSERT WITH CHECK (
 EXISTS (SELECT 1 FROM staff_user s WHERE s.id=app.current_actor_id() AND s.tenant_id=stbvv_quote_export.tenant_id AND s.active AND (
   EXISTS (SELECT 1 FROM staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER'))
   OR EXISTS (SELECT 1 FROM staff_permission p WHERE p.staff_user_id=s.id AND p.permission='INVOICE_MANAGE')
 ))
);
GRANT SELECT,INSERT ON stbvv_quote_export TO taxtronik_app;

COMMIT;
