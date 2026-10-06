CREATE OR REPLACE FUNCTION app.reconcile_resumed_workflow()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF OLD.status IN ('PAUSED','CANCELLED') AND NEW.status='ACTIVE' THEN
    PERFORM app.reconcile_workflow_instance(NEW.id);
  END IF;
  RETURN NULL;
END $function$;
