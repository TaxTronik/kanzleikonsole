CREATE OR REPLACE FUNCTION app.reconcile_workflow_item_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  PERFORM app.reconcile_workflow_instance(
    CASE WHEN TG_OP='DELETE' THEN OLD.instance_id ELSE NEW.instance_id END);
  RETURN NULL;
END $function$;
