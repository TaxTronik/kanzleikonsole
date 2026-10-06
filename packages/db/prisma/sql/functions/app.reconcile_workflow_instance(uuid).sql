CREATE OR REPLACE FUNCTION app.reconcile_workflow_instance(p_instance_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE current_status public.workflow_instance_status;
BEGIN
  SELECT status INTO current_status FROM public.workflow_instance
    WHERE id=p_instance_id FOR UPDATE;
  -- Pauses and cancellations retain their explicit organizational decision.
  -- Source responses can still be recorded; resuming reconciles their result.
  IF NOT FOUND OR current_status NOT IN ('ACTIVE','COMPLETED') THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.workflow_item WHERE instance_id=p_instance_id AND done_at IS NULL) THEN
    IF current_status='COMPLETED' THEN
      UPDATE public.workflow_instance SET status='ACTIVE', completed_at=NULL,
        feedback_pending_at=NULL WHERE id=p_instance_id;
    END IF;
  ELSIF current_status='ACTIVE' AND EXISTS(SELECT 1 FROM public.workflow_item WHERE instance_id=p_instance_id) THEN
    UPDATE public.workflow_instance SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP,
      paused_until=NULL WHERE id=p_instance_id;
  END IF;
END $function$;
