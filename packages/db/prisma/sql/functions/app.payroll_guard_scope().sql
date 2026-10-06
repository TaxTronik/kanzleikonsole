CREATE OR REPLACE FUNCTION app.payroll_guard_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  IF TG_TABLE_NAME='payroll_employer_grant' THEN
   IF NOT EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=NEW.contact_id AND c.tenant_id=i.tenant_id AND c.client_id=i.client_id) THEN RAISE EXCEPTION 'Invalid employer contact'; END IF;
  END IF;
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
END $function$;
