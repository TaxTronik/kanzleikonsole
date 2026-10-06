CREATE OR REPLACE FUNCTION app.workflow_dependency_period_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workflow-dependencies:'||NEW.tenant_id::text,0));
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_item a
    JOIN public.workflow_instance ai ON ai.id=a.instance_id
    JOIN public.workflow_item b ON b.id=NEW.successor_item_id
    JOIN public.workflow_instance bi ON bi.id=b.instance_id
    WHERE a.id=NEW.predecessor_item_id AND ai.tenant_id=NEW.tenant_id
      AND bi.tenant_id=NEW.tenant_id AND ai.assessment_year IS NOT NULL
      AND ai.assessment_year=bi.assessment_year
  ) THEN RAISE EXCEPTION 'Dependency requires the same confirmed assessment year'; END IF;
  RETURN NEW;
END $function$;
