CREATE OR REPLACE FUNCTION app.payroll_guest_save(p_session text, p_revision integer, p_answers jsonb, p_submit boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
END $function$;
