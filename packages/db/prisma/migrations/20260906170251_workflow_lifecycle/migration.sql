-- Fachkatalog: WORKFLOW-LIFECYCLE-001, CLIENT-FEEDBACK-001,
-- WORKFLOW-DEPENDENCY-001. Forward-only repair; no historical decisions inferred.
ALTER TABLE public.workflow_instance
  ADD COLUMN feedback_pending_at TIMESTAMPTZ,
  ADD COLUMN feedback_processed_at TIMESTAMPTZ;

-- Serialize sibling changes even when they originate in request/form triggers.
-- This runs after PostgreSQL has locked the item; callers must not take the
-- parent lock before updating an item (consistent item -> instance lock order).
CREATE FUNCTION app.lock_workflow_item_instance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET row_security = off AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.instance_id IS DISTINCT FROM OLD.instance_id THEN
    RAISE EXCEPTION 'Workflow-Schritte koennen nicht in einen anderen Vorgang verschoben werden.';
  END IF;
  PERFORM id FROM public.workflow_instance
    WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.instance_id ELSE NEW.instance_id END
    FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lock_workflow_item_instance() FROM PUBLIC;
CREATE TRIGGER workflow_item_instance_lock
  BEFORE INSERT OR DELETE OR UPDATE OF done_at, started_at, instance_id
  ON public.workflow_item FOR EACH ROW EXECUTE FUNCTION app.lock_workflow_item_instance();

CREATE FUNCTION app.reconcile_workflow_instance(p_instance_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET row_security = off AS $$
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
END $$;
REVOKE ALL ON FUNCTION app.reconcile_workflow_instance(UUID) FROM PUBLIC;

CREATE FUNCTION app.reconcile_workflow_item_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET row_security = off AS $$
BEGIN
  PERFORM app.reconcile_workflow_instance(
    CASE WHEN TG_OP='DELETE' THEN OLD.instance_id ELSE NEW.instance_id END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reconcile_workflow_item_change() FROM PUBLIC;
CREATE TRIGGER workflow_item_reconcile
  AFTER INSERT OR DELETE OR UPDATE OF done_at ON public.workflow_item
  FOR EACH ROW EXECUTE FUNCTION app.reconcile_workflow_item_change();

CREATE FUNCTION app.workflow_completion_feedback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET row_security = off AS $$
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
END $$;
REVOKE ALL ON FUNCTION app.workflow_completion_feedback() FROM PUBLIC;
CREATE TRIGGER workflow_completion_feedback
  BEFORE UPDATE OF status ON public.workflow_instance
  FOR EACH ROW EXECUTE FUNCTION app.workflow_completion_feedback();

CREATE FUNCTION app.reconcile_resumed_workflow() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp SET row_security = off AS $$
BEGIN
  IF OLD.status IN ('PAUSED','CANCELLED') AND NEW.status='ACTIVE' THEN
    PERFORM app.reconcile_workflow_instance(NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reconcile_resumed_workflow() FROM PUBLIC;
CREATE TRIGGER workflow_resume_reconcile AFTER UPDATE OF status ON public.workflow_instance
  FOR EACH ROW EXECUTE FUNCTION app.reconcile_resumed_workflow();
