CREATE OR REPLACE FUNCTION app.check_workflow_feedback_contact()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF NEW.feedback_contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.client_contact c WHERE c.id=NEW.feedback_contact_id AND c.client_id=NEW.client_id AND c.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Feedback contact scope mismatch'; END IF;
 RETURN NEW;
END $function$;
