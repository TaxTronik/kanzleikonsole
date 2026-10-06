CREATE OR REPLACE FUNCTION public.trg_request_closed_complete_workflow_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.workflow_item_id IS NOT NULL
     AND NEW.closed_at IS NOT NULL
     AND (OLD.closed_at IS NULL OR OLD.workflow_item_id IS NULL) THEN
    UPDATE "workflow_item"
       SET done_at = COALESCE(done_at, NEW.closed_at),
           done_by_staff = COALESCE(done_by_staff, NEW.closed_by_staff)
     WHERE id = NEW.workflow_item_id
       AND done_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;
