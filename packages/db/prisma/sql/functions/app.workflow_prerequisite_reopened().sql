CREATE OR REPLACE FUNCTION app.workflow_prerequisite_reopened()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
END $function$;
