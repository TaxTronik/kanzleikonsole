CREATE OR REPLACE FUNCTION app.payroll_guard_pending_sources()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF NEW.status IN ('SUBMITTED','REVIEWED') AND EXISTS (
   SELECT 1 FROM public.payroll_attachment a WHERE a.intake_id=NEW.id AND a.status='PENDING'
   AND NOT EXISTS(SELECT 1 FROM public.payroll_export e WHERE e.attachment_id=a.id)
 ) THEN RAISE EXCEPTION 'Finish pending payroll source uploads before submission'; END IF;
 RETURN NEW;
END $function$;
