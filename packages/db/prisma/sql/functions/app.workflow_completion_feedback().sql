CREATE OR REPLACE FUNCTION app.workflow_completion_feedback()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF OLD.status IN ('PAUSED','CANCELLED') AND NEW.status='COMPLETED' THEN
    RAISE EXCEPTION 'Pausierten oder abgebrochenen Workflow zuerst ausdruecklich fortsetzen.';
  END IF;
  IF NEW.status='COMPLETED' AND OLD.status<>'COMPLETED' THEN
    IF NEW.feedback_contact_id IS NOT NULL
       AND EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=NEW.tenant_id
         AND key='modules' AND value->>'feedbackSurveys'='true')
       AND NOT EXISTS(SELECT 1 FROM public.client_interaction WHERE tenant_id=NEW.tenant_id
         AND kind='FEEDBACK' AND source_id=NEW.id) THEN
      NEW.feedback_pending_at:=CURRENT_TIMESTAMP;
      NEW.feedback_processed_at:=NULL;
    ELSE
      NEW.feedback_pending_at:=NULL;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
