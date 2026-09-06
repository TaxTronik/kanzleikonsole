-- Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001.
-- Preserve a confirmed employer part and recheck upload authorization at the final write.
BEGIN;
CREATE FUNCTION app.payroll_guard_submission() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
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
END $$;
CREATE TRIGGER payroll_intake_submission_guard BEFORE UPDATE ON public.payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_submission();
CREATE TRIGGER payroll_attachment_submission_guard BEFORE INSERT OR UPDATE ON public.payroll_attachment FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_submission();
REVOKE ALL ON FUNCTION app.payroll_guard_submission() FROM PUBLIC,taxtronik_app;
COMMIT;
