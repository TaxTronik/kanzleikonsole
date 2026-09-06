-- FORM-SCHEMA-SNAPSHOT-001, KNOWLEDGE-CONTEXT-001, YEAR-END-CAMPAIGN-001,
-- TAX-NOTICE-DECISION-001, CLIENT-FEEDBACK-001. No professional approval.
BEGIN;
ALTER TABLE public.form_submission ADD COLUMN schema_snapshot JSONB;
ALTER TABLE public.workflow_instance ADD COLUMN feedback_contact_id UUID REFERENCES public.client_contact(id) ON DELETE SET NULL;
ALTER TABLE public.workflow_step ADD COLUMN wiki_article_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.workflow_item ADD COLUMN wiki_article_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.request_template ADD COLUMN wiki_article_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE public.request ADD COLUMN wiki_article_ids UUID[] NOT NULL DEFAULT '{}';

CREATE FUNCTION app.freeze_submission_schema() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE frozen JSONB;
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF NEW.schema_snapshot IS DISTINCT FROM OLD.schema_snapshot OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
     RAISE EXCEPTION 'Frozen submission schema cannot be changed';
   END IF;
   RETURN NEW;
 END IF;
 PERFORM id FROM public.form_template WHERE id = NEW.template_id AND tenant_id = NEW.tenant_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid form template scope'; END IF;
 SELECT jsonb_build_object('version', 1, 'name', t.name, 'description', t.description, 'introMd', t.intro_md,
   'fields', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'key',f.key,'label',f.label,'type',f.type,
    'required',f.required,'options',f.options,'helpText',f.help_text,'defaultValue',f.default_value,
    'minValue',f.min_value,'maxValue',f.max_value) ORDER BY f.position) FROM public.form_field f WHERE f.template_id=t.id),'[]'::jsonb))
 INTO frozen FROM public.form_template t WHERE t.id = NEW.template_id;
 -- Campaigns may bind an older campaign-frozen revision. Ordinary inserts use the current revision.
 IF NEW.schema_snapshot IS NULL THEN NEW.schema_snapshot := frozen; END IF;
 IF NEW.schema_snapshot->>'version' IS DISTINCT FROM '1' OR jsonb_typeof(NEW.schema_snapshot->'fields') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid frozen form schema';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER form_submission_frozen_schema BEFORE INSERT OR UPDATE ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION app.freeze_submission_schema();

CREATE FUNCTION app.check_wiki_context() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE scope UUID;
BEGIN
 IF TG_OP='UPDATE' AND NEW.wiki_article_ids IS NOT DISTINCT FROM OLD.wiki_article_ids THEN RETURN NEW; END IF;
 IF cardinality(NEW.wiki_article_ids)>10 THEN RAISE EXCEPTION 'Too many knowledge links'; END IF;
 IF app.current_actor_type()='CLIENT_CONTACT' AND (TG_OP='UPDATE' OR cardinality(NEW.wiki_article_ids)>0) THEN RAISE EXCEPTION 'Staff context only'; END IF;
 IF TG_TABLE_NAME='workflow_step' THEN SELECT tenant_id INTO scope FROM public.workflow_template WHERE id=NEW.template_id;
 ELSIF TG_TABLE_NAME='workflow_item' THEN SELECT tenant_id INTO scope FROM public.workflow_instance WHERE id=NEW.instance_id;
 ELSE scope := NEW.tenant_id; END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.wiki_article_ids) x WHERE NOT EXISTS(SELECT 1 FROM public.kb_article a WHERE a.id=x AND a.tenant_id=scope)) THEN
   RAISE EXCEPTION 'Knowledge article outside tenant';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_step_wiki_scope BEFORE INSERT OR UPDATE ON public.workflow_step FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
CREATE TRIGGER workflow_item_wiki_scope BEFORE INSERT OR UPDATE ON public.workflow_item FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
CREATE TRIGGER request_template_wiki_scope BEFORE INSERT OR UPDATE ON public.request_template FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();
CREATE TRIGGER request_wiki_scope BEFORE INSERT OR UPDATE ON public.request FOR EACH ROW EXECUTE FUNCTION app.check_wiki_context();

CREATE TABLE public.year_end_campaign (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 name TEXT NOT NULL, year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2200), template_id UUID NOT NULL REFERENCES public.form_template(id),
 schema_snapshot JSONB NOT NULL, due_at TIMESTAMPTZ NOT NULL, created_by_staff UUID NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(tenant_id,name,year)
);
CREATE TABLE public.year_end_campaign_entry (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 campaign_id UUID NOT NULL REFERENCES public.year_end_campaign(id), client_id UUID NOT NULL REFERENCES public.client(id),
 submission_id UUID NOT NULL UNIQUE REFERENCES public.form_submission(id), request_id UUID NOT NULL UNIQUE REFERENCES public.request(id),
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(campaign_id,client_id)
);
CREATE TABLE public.client_interaction (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 client_id UUID NOT NULL REFERENCES public.client(id), contact_id UUID NOT NULL REFERENCES public.client_contact(id),
 kind TEXT NOT NULL CHECK(kind IN ('NOTICE','FEEDBACK')), source_id UUID NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 request_id UUID NOT NULL UNIQUE REFERENCES public.request(id), snapshot JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESPONDED','REVOKED')),
 response TEXT, message TEXT, responded_at TIMESTAMP, reviewed_at TIMESTAMP, reviewed_by_staff UUID,
 expires_at TIMESTAMPTZ NOT NULL, created_by_staff UUID NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(tenant_id,kind,source_id,revision), CHECK(message IS NULL OR length(message)<=3000),
 CHECK((status='RESPONDED') = (response IS NOT NULL AND responded_at IS NOT NULL)),
 CHECK(response IS NULL OR (kind='NOTICE' AND response IN ('APPEAL_REQUESTED','NO_OBJECTIONS')) OR (kind='FEEDBACK' AND response IN ('1','2','3','4','5')))
);
CREATE INDEX client_interaction_scope ON public.client_interaction(tenant_id,client_id,status);
CREATE UNIQUE INDEX client_interaction_feedback_once ON public.client_interaction(tenant_id,source_id) WHERE kind='FEEDBACK';
CREATE UNIQUE INDEX client_interaction_notice_open ON public.client_interaction(tenant_id,source_id) WHERE kind='NOTICE' AND status='OPEN';
ALTER TABLE public.year_end_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_campaign FORCE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_campaign_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_campaign_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_interaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_interaction FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.year_end_campaign,public.year_end_campaign_entry,public.client_interaction TO taxtronik_app;
CREATE POLICY campaign_staff ON public.year_end_campaign FOR ALL USING(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_actor_is_active(tenant_id,app.current_actor_id())) WITH CHECK(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_actor_is_active(tenant_id,app.current_actor_id()));
CREATE POLICY campaign_entry_staff ON public.year_end_campaign_entry FOR ALL USING(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id));
CREATE POLICY interaction_staff ON public.client_interaction FOR ALL USING(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.current_actor_type()='STAFF' AND app.notification_staff_can_access_client(tenant_id,app.current_actor_id(),client_id));
CREATE POLICY interaction_contact_read ON public.client_interaction FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT' AND contact_id=app.current_actor_id() AND EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=contact_id AND c.client_id=client_interaction.client_id AND c.tenant_id=client_interaction.tenant_id AND c.active));
CREATE POLICY interaction_contact_reply ON public.client_interaction FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT' AND contact_id=app.current_actor_id() AND EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=contact_id AND c.client_id=client_interaction.client_id AND c.active)) WITH CHECK(tenant_id=app.current_tenant_id() AND contact_id=app.current_actor_id());

CREATE FUNCTION app.check_workflow_expansion_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='year_end_campaign' THEN
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Campaign revision is immutable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.form_template WHERE id=NEW.template_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Campaign template scope mismatch'; END IF;
 ELSIF TG_TABLE_NAME='year_end_campaign_entry' THEN
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Campaign allocation is immutable'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.year_end_campaign c JOIN public.form_submission s ON s.id=NEW.submission_id JOIN public.request r ON r.id=NEW.request_id WHERE c.id=NEW.campaign_id AND c.tenant_id=NEW.tenant_id AND s.tenant_id=NEW.tenant_id AND s.client_id=NEW.client_id AND r.tenant_id=NEW.tenant_id AND r.client_id=NEW.client_id AND r.form_submission_id=s.id AND s.schema_snapshot=c.schema_snapshot) THEN RAISE EXCEPTION 'Campaign allocation scope mismatch'; END IF;
 ELSE
   IF TG_OP='INSERT' THEN
    IF NEW.status<>'OPEN' OR NEW.response IS NOT NULL OR NEW.responded_at IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN RAISE EXCEPTION 'Interaction must start open'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.client_contact c JOIN public.request r ON r.id=NEW.request_id WHERE c.id=NEW.contact_id AND c.tenant_id=NEW.tenant_id AND c.client_id=NEW.client_id AND c.active AND r.client_id=NEW.client_id AND r.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Interaction scope mismatch'; END IF;
    IF NEW.kind='NOTICE' AND NOT EXISTS(SELECT 1 FROM public.tax_notice WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id) THEN RAISE EXCEPTION 'Notice scope mismatch'; END IF;
    IF NEW.kind='FEEDBACK' AND NOT EXISTS(SELECT 1 FROM public.workflow_instance WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND status='COMPLETED') THEN RAISE EXCEPTION 'Milestone is not complete'; END IF;
   ELSE
    IF ROW(NEW.tenant_id,NEW.client_id,NEW.contact_id,NEW.kind,NEW.source_id,NEW.request_id,NEW.snapshot,NEW.expires_at,NEW.created_by_staff,NEW.revision) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.client_id,OLD.contact_id,OLD.kind,OLD.source_id,OLD.request_id,OLD.snapshot,OLD.expires_at,OLD.created_by_staff,OLD.revision) THEN RAISE EXCEPTION 'Interaction snapshot is immutable'; END IF;
    IF app.current_actor_type()<>'CLIENT_CONTACT' AND ROW(NEW.response,NEW.message,NEW.responded_at) IS DISTINCT FROM ROW(OLD.response,OLD.message,OLD.responded_at) THEN RAISE EXCEPTION 'Only designated contact may respond'; END IF;
    IF OLD.status<>'OPEN' AND ROW(NEW.response,NEW.message,NEW.responded_at,NEW.status) IS DISTINCT FROM ROW(OLD.response,OLD.message,OLD.responded_at,OLD.status) THEN RAISE EXCEPTION 'Response is immutable'; END IF;
    IF app.current_actor_type()='CLIENT_CONTACT' THEN
      IF OLD.status<>'OPEN' OR NEW.status<>'RESPONDED' OR OLD.expires_at<=CURRENT_TIMESTAMP OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by_staff IS DISTINCT FROM OLD.reviewed_by_staff THEN RAISE EXCEPTION 'Invalid interaction response'; END IF;
      PERFORM id FROM public.request WHERE id=NEW.request_id AND status IN ('OPEN','IN_PROGRESS') FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Interaction request is closed'; END IF;
      NEW.responded_at:=CURRENT_TIMESTAMP;
      IF NEW.kind='NOTICE' AND NOT EXISTS(SELECT 1 FROM public.tax_notice n JOIN public.document d ON d.id=n.document_id JOIN public.document_version v ON v.document_id=d.id WHERE n.id=NEW.source_id AND n.status='GEPRUEFT' AND n.updated_at=(NEW.snapshot->>'noticeUpdatedAt')::timestamptz AND d.shared_with_client_at IS NOT NULL AND d.deleted_at IS NULL AND v.id=(NEW.snapshot->>'documentVersionId')::uuid AND NOT EXISTS(SELECT 1 FROM public.document_version newer WHERE newer.document_id=d.id AND newer.version_no>v.version_no)) THEN RAISE EXCEPTION 'Notice revision changed'; END IF;
    END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_scope BEFORE INSERT OR UPDATE ON public.year_end_campaign FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();
CREATE TRIGGER campaign_entry_scope BEFORE INSERT OR UPDATE ON public.year_end_campaign_entry FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();
CREATE TRIGGER interaction_scope BEFORE INSERT OR UPDATE ON public.client_interaction FOR EACH ROW EXECUTE FUNCTION app.check_workflow_expansion_scope();

CREATE FUNCTION app.interaction_request(p_request_id UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.client_interaction i JOIN public.client_contact c ON c.id=app.current_actor_id() AND c.client_id=i.client_id AND c.tenant_id=i.tenant_id AND c.active WHERE i.request_id=p_request_id AND i.tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT');
$$;
REVOKE ALL ON FUNCTION app.interaction_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.interaction_request(UUID) TO taxtronik_app;

CREATE FUNCTION app.check_workflow_feedback_contact() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.feedback_contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=NEW.feedback_contact_id AND c.client_id=NEW.client_id AND c.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Feedback contact scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_feedback_contact_scope BEFORE INSERT OR UPDATE ON public.workflow_instance FOR EACH ROW EXECUTE FUNCTION app.check_workflow_feedback_contact();

-- Return only currently authorized internal recipients for this designated contact's response.
CREATE FUNCTION app.interaction_notification_recipients(p_interaction_id UUID) RETURNS TABLE(staff_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH context AS (
  SELECT i.* FROM public.client_interaction i JOIN public.client_contact c ON c.id=i.contact_id AND c.active
  WHERE i.id=p_interaction_id AND i.tenant_id=app.current_tenant_id() AND i.contact_id=app.current_actor_id()
    AND app.current_actor_type()='CLIENT_CONTACT' AND c.client_id=i.client_id AND c.tenant_id=i.tenant_id
 ), candidates AS (
  SELECT s.id,
   EXISTS(SELECT 1 FROM public.client_responsibility r WHERE r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.staff_id=s.id AND r.role='HAUPTBEARBEITER') AS main,
   s.id=i.created_by_staff AS creator,
   EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER')) AS admin
  FROM context i JOIN public.client c ON c.id=i.client_id JOIN public.staff_user s ON s.tenant_id=i.tenant_id AND s.active
  WHERE EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER'))
   OR EXISTS(SELECT 1 FROM public.client_responsibility r WHERE r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.staff_id=s.id AND r.role IN ('HAUPTBEARBEITER','BERUFSTRAEGER'))
   OR (NOT c.vertraulich AND NOT EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='access' AND t.value->>'clientAccessMode'='RESTRICTED'))
 ) SELECT id FROM candidates WHERE CASE WHEN EXISTS(SELECT 1 FROM candidates WHERE main) THEN main WHEN EXISTS(SELECT 1 FROM candidates WHERE creator) THEN creator ELSE admin END;
$$;
REVOKE ALL ON FUNCTION app.interaction_notification_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.interaction_notification_recipients(UUID) TO taxtronik_app;
COMMIT;
