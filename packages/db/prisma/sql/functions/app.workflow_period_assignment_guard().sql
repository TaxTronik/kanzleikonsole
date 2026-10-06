CREATE OR REPLACE FUNCTION app.workflow_period_assignment_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  IF NEW.assessment_year IS DISTINCT FROM OLD.assessment_year THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('workflow-dependencies:'||NEW.tenant_id::text,0));
    IF EXISTS (
      SELECT 1 FROM public.workflow_dependency d
      JOIN public.workflow_item i ON i.id=d.predecessor_item_id OR i.id=d.successor_item_id
      WHERE d.tenant_id=NEW.tenant_id AND i.instance_id=NEW.id
    ) THEN RAISE EXCEPTION 'Remove workflow dependencies before changing their assessment year'; END IF;
  END IF;
  RETURN NEW;
END $function$;
