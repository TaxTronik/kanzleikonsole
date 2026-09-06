-- Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001.
-- A source upload must remain recoverable until it completes; the final submission waits.
BEGIN;
CREATE FUNCTION app.payroll_guard_pending_sources() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.status IN ('SUBMITTED','REVIEWED') AND EXISTS (
   SELECT 1 FROM public.payroll_attachment a WHERE a.intake_id=NEW.id AND a.status='PENDING'
   AND NOT EXISTS(SELECT 1 FROM public.payroll_export e WHERE e.attachment_id=a.id)
 ) THEN RAISE EXCEPTION 'Finish pending payroll source uploads before submission'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_intake_pending_sources BEFORE UPDATE ON public.payroll_intake FOR EACH ROW EXECUTE FUNCTION app.payroll_guard_pending_sources();
REVOKE ALL ON FUNCTION app.payroll_guard_pending_sources() FROM PUBLIC,taxtronik_app;
COMMIT;
