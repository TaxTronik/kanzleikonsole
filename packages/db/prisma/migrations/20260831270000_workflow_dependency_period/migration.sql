-- WORKFLOW-DEPENDENCY-001 / ACCESS-NOTIFICATION-RECIPIENT-001
-- No historical period is inferred from labels or creation dates.
ALTER TYPE public.notification_kind ADD VALUE 'WORKFLOW_PREREQUISITE_REOPENED';
ALTER TABLE public.workflow_instance ADD COLUMN assessment_year INTEGER
  CHECK (assessment_year BETWEEN 1900 AND 2200);

CREATE FUNCTION app.workflow_dependency_period_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
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
END $$;
CREATE TRIGGER workflow_dependency_period_guard BEFORE INSERT OR UPDATE ON public.workflow_dependency
FOR EACH ROW EXECUTE FUNCTION app.workflow_dependency_period_guard();

CREATE FUNCTION app.workflow_period_assignment_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
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
END $$;
CREATE TRIGGER workflow_period_assignment_guard BEFORE UPDATE OF assessment_year ON public.workflow_instance
FOR EACH ROW EXECUTE FUNCTION app.workflow_period_assignment_guard();

-- Only a real reopen emits an event. This trigger has no public callable RPC,
-- accepts no recipient/content input and never alters a deadline or successor.
CREATE FUNCTION app.workflow_prerequisite_reopened() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE current_tenant UUID;
BEGIN
  IF OLD.done_at IS NULL OR NEW.done_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO current_tenant FROM public.workflow_instance WHERE id=NEW.instance_id;
  IF current_tenant IS DISTINCT FROM app.current_tenant_id()
    OR app.current_actor_type() NOT IN ('STAFF','SYSTEM')
    OR NOT EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=current_tenant
      AND key='modules' AND value->>'workflowDependencies'='true') THEN RETURN NEW; END IF;
  INSERT INTO public.notification(tenant_id,client_id,staff_id,kind,title,body,href,resource_type,resource_id)
    SELECT DISTINCT current_tenant, c.id, s.id, 'WORKFLOW_PREREQUISITE_REOPENED'::public.notification_kind,
      'Workflow-Vorleistung erneut offen',
      'Eine ausdrücklich verknüpfte Vorleistung wurde wieder geöffnet. Bitte die Bereitschaft der abhängigen Workflows erneut prüfen.',
      '/staff/mandate-expansion/dependencies', 'client', c.id::text
    FROM public.workflow_dependency d
    JOIN public.workflow_item target ON target.id=d.successor_item_id
    JOIN public.workflow_instance wi ON wi.id=target.instance_id AND wi.tenant_id=current_tenant
    JOIN public.client c ON c.id=wi.client_id AND c.tenant_id=current_tenant AND c.anonymized_at IS NULL
    JOIN public.staff_user s ON s.id=COALESCE(target.assignee_staff_id,wi.started_by_staff)
      AND s.tenant_id=current_tenant AND s.active
    WHERE d.tenant_id=current_tenant AND d.predecessor_item_id=NEW.id
      AND (
        EXISTS(SELECT 1 FROM public.staff_role r WHERE r.staff_user_id=s.id AND r.role IN ('ADMIN','PARTNER'))
        OR (NOT c.vertraulich AND NOT EXISTS(SELECT 1 FROM public.tenant_setting setting
          WHERE setting.tenant_id=current_tenant AND setting.key='access' AND setting.value->>'clientAccessMode'='RESTRICTED'))
        OR EXISTS(SELECT 1 FROM public.client_responsibility r WHERE r.tenant_id=current_tenant
          AND r.client_id=c.id AND r.staff_id=s.id AND r.role IN ('BERUFSTRAEGER','HAUPTBEARBEITER'))
      );
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.workflow_prerequisite_reopened() FROM PUBLIC;
CREATE TRIGGER workflow_prerequisite_reopened AFTER UPDATE OF done_at ON public.workflow_item
FOR EACH ROW EXECUTE FUNCTION app.workflow_prerequisite_reopened();
