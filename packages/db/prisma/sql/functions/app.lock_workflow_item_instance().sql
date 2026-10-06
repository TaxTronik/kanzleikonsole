CREATE OR REPLACE FUNCTION app.lock_workflow_item_instance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND NEW.instance_id IS DISTINCT FROM OLD.instance_id THEN
    RAISE EXCEPTION 'Workflow-Schritte koennen nicht in einen anderen Vorgang verschoben werden.';
  END IF;
  PERFORM id FROM public.workflow_instance
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.instance_id ELSE NEW.instance_id END
    FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;
