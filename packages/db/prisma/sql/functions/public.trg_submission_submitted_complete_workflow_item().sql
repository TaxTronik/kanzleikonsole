CREATE OR REPLACE FUNCTION public.trg_submission_submitted_complete_workflow_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.workflow_item_id IS NOT NULL
     AND NEW.submitted_at IS NOT NULL
     AND OLD.submitted_at IS NULL THEN
    UPDATE "workflow_item"
       SET done_at = COALESCE(done_at, NEW.submitted_at)
     WHERE id = NEW.workflow_item_id
       AND done_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;
