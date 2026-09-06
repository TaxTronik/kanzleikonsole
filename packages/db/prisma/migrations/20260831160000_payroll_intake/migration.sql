-- Fachkatalog: PAYROLL-INTAKE-001. Separate payroll ACL; no general portal documents.
BEGIN;
CREATE TABLE payroll_intake (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), client_id UUID NOT NULL REFERENCES client(id),
 employee_label TEXT NOT NULL, schema_snapshot JSONB NOT NULL, employer_answers JSONB NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','RETURNED','REVIEWED')),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMP(3), employer_confirmed_at TIMESTAMP(3), employee_submitted_at TIMESTAMP(3),
 reviewed_at TIMESTAMP(3), reviewed_by_staff UUID, review_note TEXT, advisor_number TEXT, client_number TEXT, personnel_number TEXT,
 numbers_confirmed_at TIMESTAMP(3), created_by_staff UUID NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payroll_intake_tenant_id_client_id_idx ON payroll_intake(tenant_id,client_id);
CREATE TABLE payroll_employee_data (intake_id UUID PRIMARY KEY REFERENCES payroll_intake(id), tenant_id UUID NOT NULL REFERENCES tenant(id), answers JSONB NOT NULL DEFAULT '{}');
CREATE TABLE payroll_revision (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 revision INTEGER NOT NULL, snapshot JSONB NOT NULL, actor_id UUID, actor_type TEXT NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(intake_id,revision)
);
CREATE TABLE payroll_employer_grant (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 contact_id UUID NOT NULL REFERENCES client_contact(id), active BOOLEAN NOT NULL DEFAULT true, UNIQUE(intake_id,contact_id)
);
CREATE TABLE payroll_employee_invite (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), expires_at TIMESTAMPTZ NOT NULL, redeemed_at TIMESTAMP(3), revoked_at TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE payroll_guest_session (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), invite_id UUID NOT NULL REFERENCES payroll_employee_invite(id),
 token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMP(3)
);
CREATE TABLE payroll_attachment (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 audience TEXT NOT NULL CHECK(audience IN ('EMPLOYER','EMPLOYEE','STAFF')), uploaded_by UUID NOT NULL, revision INTEGER NOT NULL,
 filename TEXT NOT NULL CHECK(length(filename)<=180), mime_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETE')),
 storage_bucket TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, storage_version_id TEXT, sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 size_bytes BIGINT NOT NULL CHECK(size_bytes>0 AND size_bytes<=26214400), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((status='COMPLETE')=(storage_version_id IS NOT NULL))
);
CREATE INDEX payroll_attachment_tenant_id_intake_id_idx ON payroll_attachment(tenant_id,intake_id);
CREATE TABLE payroll_export (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('PDF','ZIP','DATEV_LUG')), status TEXT NOT NULL CHECK(status IN ('PENDING','COMPLETE','BLOCKED')),
 explanation TEXT NOT NULL, attachment_id UUID REFERENCES payroll_attachment(id), created_by_staff UUID NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(kind<>'DATEV_LUG' OR status='BLOCKED')
);
CREATE TABLE payroll_external_task (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES tenant(id), intake_id UUID NOT NULL REFERENCES payroll_intake(id),
 kind TEXT NOT NULL DEFAULT 'SOFORTMELDUNG' CHECK(kind='SOFORTMELDUNG'), status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','NOT_REQUIRED','EVIDENCE_RECORDED')),
 evidence TEXT, recorded_by_staff UUID, recorded_at TIMESTAMP(3), UNIQUE(intake_id,kind),
 CHECK(status='OPEN' OR (length(evidence)>=10 AND recorded_by_staff IS NOT NULL AND recorded_at IS NOT NULL))
);

CREATE FUNCTION app.payroll_staff_access(tid UUID, cid UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT tid=app.current_tenant_id() AND app.current_actor_type()='STAFF'
  AND app.expansion_staff_permission(tid,app.current_actor_id(),'PAYROLL_MANAGE')
  AND app.notification_staff_can_access_client(tid,app.current_actor_id(),cid);
$$;
CREATE FUNCTION app.payroll_employer_access(pid UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_intake i JOIN public.payroll_employer_grant g ON g.intake_id=i.id
 JOIN public.client_contact cc ON cc.id=g.contact_id JOIN public.client c ON c.id=i.client_id
 WHERE i.id=pid AND i.tenant_id=app.current_tenant_id() AND app.current_actor_type()='CLIENT_CONTACT'
 AND cc.id=app.current_actor_id() AND cc.tenant_id=i.tenant_id AND cc.client_id=i.client_id AND cc.active AND g.active
 AND g.tenant_id=i.tenant_id AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL);
$$;
CREATE FUNCTION app.payroll_staff_intake(pid UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_intake i WHERE i.id=pid AND app.payroll_staff_access(i.tenant_id,i.client_id));
$$;
REVOKE ALL ON FUNCTION app.payroll_staff_access(UUID,UUID),app.payroll_employer_access(UUID),app.payroll_staff_intake(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_staff_access(UUID,UUID),app.payroll_employer_access(UUID),app.payroll_staff_intake(UUID) TO taxtronik_app;

ALTER TABLE payroll_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_intake FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_intake_staff ON payroll_intake FOR ALL USING(app.payroll_staff_access(tenant_id,client_id)) WITH CHECK(app.payroll_staff_access(tenant_id,client_id));
CREATE POLICY payroll_intake_employer_read ON payroll_intake FOR SELECT USING(app.payroll_employer_access(id));
CREATE POLICY payroll_intake_employer_update ON payroll_intake FOR UPDATE USING(app.payroll_employer_access(id)) WITH CHECK(app.payroll_employer_access(id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_intake TO taxtronik_app;
ALTER TABLE payroll_employee_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employee_data FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_employee_data_staff ON payroll_employee_data FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_employee_data TO taxtronik_app;
ALTER TABLE payroll_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_revision_staff ON payroll_revision FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_revision TO taxtronik_app;
ALTER TABLE payroll_employer_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employer_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_employer_grant_staff ON payroll_employer_grant FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_employer_grant TO taxtronik_app;
ALTER TABLE payroll_employee_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employee_invite FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_employee_invite_staff ON payroll_employee_invite FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_employee_invite TO taxtronik_app;
ALTER TABLE payroll_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_attachment_staff ON payroll_attachment FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_attachment TO taxtronik_app;
ALTER TABLE payroll_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_export FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_export_staff ON payroll_export FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_export TO taxtronik_app;
ALTER TABLE payroll_external_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_external_task FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_external_task_staff ON payroll_external_task FOR ALL USING(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_staff_intake(intake_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_external_task TO taxtronik_app;
ALTER TABLE payroll_guest_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_guest_session FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_session_staff ON payroll_guest_session FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM payroll_employee_invite v WHERE v.id=invite_id AND app.payroll_staff_intake(v.intake_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM payroll_employee_invite v WHERE v.id=invite_id AND app.payroll_staff_intake(v.intake_id)));
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_guest_session TO taxtronik_app;
CREATE POLICY payroll_grant_employer_read ON payroll_employer_grant FOR SELECT USING(tenant_id=app.current_tenant_id() AND contact_id=app.current_actor_id() AND app.payroll_employer_access(intake_id));
CREATE POLICY payroll_invite_employer ON payroll_employee_invite FOR ALL USING(app.payroll_employer_access(intake_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_employer_access(intake_id));
CREATE POLICY payroll_attachment_employer_read ON payroll_attachment FOR SELECT USING(app.payroll_employer_access(intake_id) AND audience='EMPLOYER' AND uploaded_by=app.current_actor_id());
CREATE POLICY payroll_attachment_employer_insert ON payroll_attachment FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_employer_access(intake_id) AND audience='EMPLOYER' AND uploaded_by=app.current_actor_id());
CREATE POLICY payroll_attachment_employer_update ON payroll_attachment FOR UPDATE USING(app.payroll_employer_access(intake_id) AND audience='EMPLOYER' AND uploaded_by=app.current_actor_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_employer_access(intake_id) AND audience='EMPLOYER' AND uploaded_by=app.current_actor_id());
REVOKE UPDATE,DELETE ON payroll_revision FROM taxtronik_app;

CREATE FUNCTION app.payroll_guard_scope() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.payroll_intake;
BEGIN
 IF TG_TABLE_NAME='payroll_intake' THEN
  IF NOT EXISTS(SELECT 1 FROM public.client WHERE id=NEW.client_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid payroll client scope'; END IF;
  IF TG_OP='UPDATE' THEN
   IF ROW(NEW.tenant_id,NEW.client_id,NEW.schema_snapshot,NEW.employee_label,NEW.created_by_staff) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.client_id,OLD.schema_snapshot,OLD.employee_label,OLD.created_by_staff) THEN RAISE EXCEPTION 'Payroll source is immutable'; END IF;
   IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Payroll revision conflict'; END IF;
   IF OLD.status NOT IN ('DRAFT','RETURNED') AND NEW.employer_answers IS DISTINCT FROM OLD.employer_answers THEN RAISE EXCEPTION 'Submitted employment is immutable'; END IF;
   IF app.current_actor_type()='CLIENT_CONTACT' THEN
    IF NEW.status NOT IN ('DRAFT','SUBMITTED') OR OLD.status NOT IN ('DRAFT','RETURNED')
      OR ROW(NEW.expires_at,NEW.revoked_at,NEW.employee_submitted_at,NEW.reviewed_at,NEW.reviewed_by_staff,NEW.review_note,NEW.advisor_number,NEW.client_number,NEW.personnel_number,NEW.numbers_confirmed_at)
       IS DISTINCT FROM ROW(OLD.expires_at,OLD.revoked_at,OLD.employee_submitted_at,OLD.reviewed_at,OLD.reviewed_by_staff,OLD.review_note,OLD.advisor_number,OLD.client_number,OLD.personnel_number,OLD.numbers_confirmed_at) THEN RAISE EXCEPTION 'Employer cannot change internal payroll state'; END IF;
   END IF;
  END IF;
 ELSE
  SELECT * INTO i FROM public.payroll_intake WHERE id=NEW.intake_id;
  IF i.id IS NULL OR i.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'Invalid payroll scope'; END IF;
  IF TG_TABLE_NAME='payroll_employer_grant' AND NOT EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=NEW.contact_id AND c.tenant_id=i.tenant_id AND c.client_id=i.client_id) THEN RAISE EXCEPTION 'Invalid employer contact'; END IF;
  IF TG_TABLE_NAME='payroll_employee_invite' THEN
   IF NEW.expires_at>i.expires_at THEN RAISE EXCEPTION 'Invite exceeds intake deadline'; END IF;
   IF TG_OP='UPDATE' AND ROW(NEW.intake_id,NEW.tenant_id,NEW.token_hash,NEW.expires_at) IS DISTINCT FROM ROW(OLD.intake_id,OLD.tenant_id,OLD.token_hash,OLD.expires_at) THEN RAISE EXCEPTION 'Invite is immutable'; END IF;
  END IF;
  IF TG_TABLE_NAME='payroll_attachment' THEN
   IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Upload requires a pending journal'; END IF;
   IF NEW.revision>i.revision OR NEW.storage_key NOT LIKE 'tenants/'||i.tenant_id::text||'/none/%' THEN RAISE EXCEPTION 'Invalid payroll upload intent'; END IF;
   IF TG_OP='UPDATE' AND (OLD.status='COMPLETE' OR ROW(NEW.intake_id,NEW.tenant_id,NEW.audience,NEW.uploaded_by,NEW.revision,NEW.filename,NEW.mime_type,NEW.storage_bucket,NEW.storage_key,NEW.sha256,NEW.size_bytes) IS DISTINCT FROM ROW(OLD.intake_id,OLD.tenant_id,OLD.audience,OLD.uploaded_by,OLD.revision,OLD.filename,OLD.mime_type,OLD.storage_bucket,OLD.storage_key,OLD.sha256,OLD.size_bytes)) THEN RAISE EXCEPTION 'Payroll attachment is immutable'; END IF;
  END IF;
  IF TG_TABLE_NAME='payroll_export' THEN
   IF NEW.attachment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_attachment a WHERE a.id=NEW.attachment_id AND a.intake_id=i.id AND a.tenant_id=i.tenant_id AND a.revision=NEW.revision AND a.audience='STAFF') THEN RAISE EXCEPTION 'Export artifact scope mismatch'; END IF;
   IF TG_OP='UPDATE' AND (ROW(NEW.tenant_id,NEW.intake_id,NEW.revision,NEW.kind,NEW.explanation,NEW.created_by_staff) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.intake_id,OLD.revision,OLD.kind,OLD.explanation,OLD.created_by_staff) OR (OLD.attachment_id IS NOT NULL AND NEW.attachment_id IS DISTINCT FROM OLD.attachment_id) OR OLD.status<>'PENDING') THEN RAISE EXCEPTION 'Export history is immutable'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_intake_scope BEFORE INSERT OR UPDATE ON payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_employee_data_scope BEFORE INSERT OR UPDATE ON payroll_employee_data FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_revision_scope BEFORE INSERT OR UPDATE ON payroll_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_employer_grant_scope BEFORE INSERT OR UPDATE ON payroll_employer_grant FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_employee_invite_scope BEFORE INSERT OR UPDATE ON payroll_employee_invite FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_attachment_scope BEFORE INSERT OR UPDATE ON payroll_attachment FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_export_scope BEFORE INSERT OR UPDATE ON payroll_export FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();
CREATE TRIGGER payroll_external_task_scope BEFORE INSERT OR UPDATE ON payroll_external_task FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_scope();

CREATE FUNCTION app.payroll_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Payroll history is immutable'; END $$;
CREATE TRIGGER payroll_revision_immutable BEFORE UPDATE ON payroll_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();

-- Guest browser code always runs with this empty context. It never adopts a real tenant or portal identity.
CREATE FUNCTION app.payroll_assert_empty_context() RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR app.current_actor_id() IS NOT NULL THEN RAISE EXCEPTION 'Invalid capability context'; END IF;
END $$;
CREATE FUNCTION app.payroll_guest_intake(p_session TEXT) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID;
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_session !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT i.id INTO pid FROM public.payroll_guest_session s JOIN public.payroll_employee_invite v ON v.id=s.invite_id
 JOIN public.payroll_intake i ON i.id=v.intake_id JOIN public.client c ON c.id=i.client_id
 WHERE s.token_hash=p_session AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP
 AND v.revoked_at IS NULL AND v.expires_at>CURRENT_TIMESTAMP AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP
 AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL
 AND EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='modules' AND t.value->>'payrollIntake'='true')
 FOR SHARE OF s,v,i,c;
 RETURN pid;
END $$;
CREATE FUNCTION app.payroll_guest_exchange(p_invite TEXT,p_session TEXT) RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v public.payroll_employee_invite; expiry TIMESTAMPTZ;
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_invite !~ '^[a-f0-9]{64}$' OR p_session !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT x.* INTO v FROM public.payroll_employee_invite x JOIN public.payroll_intake i ON i.id=x.intake_id JOIN public.client c ON c.id=i.client_id
 WHERE x.token_hash=p_invite AND x.redeemed_at IS NULL AND x.revoked_at IS NULL AND x.expires_at>CURRENT_TIMESTAMP
 AND i.revoked_at IS NULL AND i.expires_at>CURRENT_TIMESTAMP AND c.allow_active AND c.mandate_ended_at IS NULL AND c.anonymized_at IS NULL
 AND EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=i.tenant_id AND t.key='modules' AND t.value->>'payrollIntake'='true')
 FOR UPDATE OF x;
 IF v.id IS NULL THEN RETURN NULL; END IF;
 expiry:=LEAST(v.expires_at,CURRENT_TIMESTAMP+INTERVAL '8 hours');
 UPDATE public.payroll_employee_invite SET redeemed_at=CURRENT_TIMESTAMP WHERE id=v.id;
 INSERT INTO public.payroll_guest_session(tenant_id,invite_id,token_hash,expires_at) VALUES(v.tenant_id,v.id,p_session,expiry);
 RETURN expiry;
END $$;
CREATE FUNCTION app.payroll_guest_read(p_session TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID; result JSONB;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('id',i.id,'tenantId',i.tenant_id,'revision',i.revision,'status',i.status,'label',i.employee_label,
 'schema',i.schema_snapshot->'employee','answers',COALESCE(d.answers,'{}'::jsonb),'submitted',i.employee_submitted_at IS NOT NULL,'expiresAt',i.expires_at,
 'reviewNote',i.review_note,'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'status',a.status)) FROM public.payroll_attachment a WHERE a.intake_id=i.id AND a.audience='EMPLOYEE'),'[]'::jsonb))
 INTO result FROM public.payroll_intake i LEFT JOIN public.payroll_employee_data d ON d.intake_id=i.id WHERE i.id=pid;
 RETURN result;
END $$;
CREATE FUNCTION app.payroll_capture_revision(pid UUID,p_actor UUID,p_type TEXT) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 INSERT INTO public.payroll_revision(tenant_id,intake_id,revision,snapshot,actor_id,actor_type)
 SELECT i.tenant_id,i.id,i.revision,jsonb_build_object('schema',i.schema_snapshot,'employer',i.employer_answers,'employee',COALESCE(d.answers,'{}'::jsonb),
 'status',i.status,'employerConfirmedAt',i.employer_confirmed_at,'employeeSubmittedAt',i.employee_submitted_at,'advisorNumber',i.advisor_number,'clientNumber',i.client_number,'personnelNumber',i.personnel_number,'numbersConfirmedAt',i.numbers_confirmed_at,
 'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'sha256',a.sha256,'versionId',a.storage_version_id)) FROM public.payroll_attachment a WHERE a.intake_id=i.id AND a.status='COMPLETE'),'[]'::jsonb)),p_actor,p_type
 FROM public.payroll_intake i LEFT JOIN public.payroll_employee_data d ON d.intake_id=i.id WHERE i.id=pid;
$$;
CREATE FUNCTION app.payroll_guest_save(p_session TEXT,p_revision INTEGER,p_answers JSONB,p_submit BOOLEAN) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID; i public.payroll_intake; sid UUID;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN false; END IF;
 SELECT * INTO i FROM public.payroll_intake WHERE id=pid FOR UPDATE;
 IF i.revision<>p_revision OR i.status NOT IN ('DRAFT','RETURNED') OR i.employee_submitted_at IS NOT NULL THEN RETURN false; END IF;
 IF p_submit AND EXISTS(SELECT 1 FROM public.payroll_attachment WHERE intake_id=pid AND audience='EMPLOYEE' AND status='PENDING') THEN RAISE EXCEPTION 'Finish pending uploads first'; END IF;
 IF jsonb_typeof(p_answers)<>'object' OR octet_length(p_answers::text)>40000 OR EXISTS(SELECT 1 FROM jsonb_each(p_answers) x WHERE jsonb_typeof(x.value)<>'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i.schema_snapshot->'employee') f WHERE f->>'key'=x.key)) THEN RAISE EXCEPTION 'Invalid employee fields'; END IF;
 IF p_submit AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.schema_snapshot->'employee') f WHERE f->>'required'='true' AND length(trim(COALESCE(p_answers->>(f->>'key'),'')))=0) THEN RAISE EXCEPTION 'Required employee fields missing'; END IF;
 INSERT INTO public.payroll_employee_data(intake_id,tenant_id,answers) VALUES(pid,i.tenant_id,p_answers) ON CONFLICT(intake_id) DO UPDATE SET answers=excluded.answers;
 UPDATE public.payroll_intake SET revision=revision+1,employee_submitted_at=CASE WHEN p_submit THEN CURRENT_TIMESTAMP ELSE NULL END,
 status=CASE WHEN p_submit AND employer_confirmed_at IS NOT NULL THEN 'SUBMITTED' ELSE 'DRAFT' END WHERE id=pid;
 SELECT id INTO sid FROM public.payroll_guest_session WHERE token_hash=p_session;
 PERFORM app.payroll_capture_revision(pid,sid,'EMPLOYEE');
 RETURN true;
END $$;
CREATE FUNCTION app.payroll_guest_upload_intent(p_session TEXT,p_data JSONB) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID; i public.payroll_intake; sid UUID; aid UUID;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO i FROM public.payroll_intake WHERE id=pid FOR UPDATE;
 IF i.status NOT IN ('DRAFT','RETURNED') OR i.employee_submitted_at IS NOT NULL THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM public.payroll_attachment WHERE intake_id=pid AND audience='EMPLOYEE')>=20 THEN RAISE EXCEPTION 'Attachment limit'; END IF;
 SELECT id INTO sid FROM public.payroll_guest_session WHERE token_hash=p_session;
 INSERT INTO public.payroll_attachment(tenant_id,intake_id,audience,uploaded_by,revision,filename,mime_type,storage_bucket,storage_key,sha256,size_bytes)
 VALUES(i.tenant_id,pid,'EMPLOYEE',sid,i.revision,p_data->>'filename',p_data->>'mimeType',p_data->>'storageBucket',p_data->>'storageKey',p_data->>'sha256',(p_data->>'sizeBytes')::bigint) RETURNING id INTO aid;
 RETURN aid;
END $$;
CREATE FUNCTION app.payroll_guest_attachment(p_session TEXT,p_id UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID; result JSONB;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL THEN RETURN NULL; END IF;
 SELECT to_jsonb(a) INTO result FROM public.payroll_attachment a WHERE a.id=p_id AND a.intake_id=pid AND a.audience='EMPLOYEE';
 RETURN result;
END $$;
CREATE FUNCTION app.payroll_guest_upload_finish(p_session TEXT,p_id UUID,p_version TEXT) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE pid UUID;
BEGIN
 pid:=app.payroll_guest_intake(p_session); IF pid IS NULL OR length(p_version)=0 THEN RETURN false; END IF;
 UPDATE public.payroll_attachment SET storage_version_id=p_version,status='COMPLETE' WHERE id=p_id AND intake_id=pid AND audience='EMPLOYEE' AND status='PENDING';
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.payroll_assert_empty_context(),app.payroll_guest_intake(TEXT),app.payroll_capture_revision(UUID,UUID,TEXT) FROM PUBLIC,taxtronik_app;
REVOKE ALL ON FUNCTION app.payroll_guest_exchange(TEXT,TEXT),app.payroll_guest_read(TEXT),app.payroll_guest_save(TEXT,INTEGER,JSONB,BOOLEAN),app.payroll_guest_upload_intent(TEXT,JSONB),app.payroll_guest_attachment(TEXT,UUID),app.payroll_guest_upload_finish(TEXT,UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_guest_exchange(TEXT,TEXT),app.payroll_guest_read(TEXT),app.payroll_guest_save(TEXT,INTEGER,JSONB,BOOLEAN),app.payroll_guest_upload_intent(TEXT,JSONB),app.payroll_guest_attachment(TEXT,UUID),app.payroll_guest_upload_finish(TEXT,UUID,TEXT) TO taxtronik_app;
CREATE FUNCTION app.payroll_capture_authorized_revision(pid UUID) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT app.payroll_staff_intake(pid) AND NOT app.payroll_employer_access(pid) THEN RAISE EXCEPTION 'Payroll access denied'; END IF;
 PERFORM app.payroll_capture_revision(pid,app.current_actor_id(),app.current_actor_type());
END $$;
REVOKE ALL ON FUNCTION app.payroll_capture_authorized_revision(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_capture_authorized_revision(UUID) TO taxtronik_app;
CREATE FUNCTION app.payroll_guest_logout(p_session TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM app.payroll_assert_empty_context();
 IF p_session ~ '^[a-f0-9]{64}$' THEN UPDATE public.payroll_guest_session SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=p_session; END IF;
END $$;
REVOKE ALL ON FUNCTION app.payroll_guest_logout(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_guest_logout(TEXT) TO taxtronik_app;
COMMIT;
