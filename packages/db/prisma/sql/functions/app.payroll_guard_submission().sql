CREATE OR REPLACE FUNCTION app.payroll_guard_submission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE i public.payroll_intake;
BEGIN
 IF TG_TABLE_NAME='payroll_intake' THEN
  IF OLD.employer_confirmed_at IS NOT NULL AND
    ROW(NEW.employer_answers,NEW.employer_confirmed_at) IS DISTINCT FROM ROW(OLD.employer_answers,OLD.employer_confirmed_at) AND
    NOT (app.current_actor_type()='STAFF' AND NEW.status='RETURNED' AND NEW.employer_confirmed_at IS NULL AND NEW.employer_answers=OLD.employer_answers)
    THEN RAISE EXCEPTION 'Confirmed employer part requires staff return'; END IF;
 ELSE
  SELECT * INTO i FROM public.payroll_intake WHERE id=NEW.intake_id FOR UPDATE;
  IF i.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Payroll intake revoked'; END IF;
  IF NEW.audience='STAFF' AND i.status='REVIEWED' THEN
   IF NEW.revision<>i.revision THEN RAISE EXCEPTION 'Reviewed payroll revision changed'; END IF;
   IF TG_OP='UPDATE' AND NOT EXISTS(SELECT 1 FROM public.payroll_export e WHERE e.attachment_id=NEW.id AND e.intake_id=i.id AND e.revision=i.revision AND e.kind IN ('PDF','ZIP') AND e.status='PENDING') THEN RAISE EXCEPTION 'Reviewed upload requires a bound export'; END IF;
  ELSE
   IF i.status NOT IN ('DRAFT','RETURNED') OR i.expires_at<=CURRENT_TIMESTAMP
     OR (NEW.audience='EMPLOYER' AND i.employer_confirmed_at IS NOT NULL)
     OR (NEW.audience='EMPLOYEE' AND i.employee_submitted_at IS NOT NULL)
     THEN RAISE EXCEPTION 'Payroll part not open for upload'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
