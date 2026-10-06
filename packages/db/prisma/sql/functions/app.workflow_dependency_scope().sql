CREATE OR REPLACE FUNCTION app.workflow_dependency_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('workflow-dependencies:'||NEW.tenant_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.workflow_item a JOIN public.workflow_instance ai ON ai.id=a.instance_id JOIN public.workflow_item b ON b.id=NEW.successor_item_id JOIN public.workflow_instance bi ON bi.id=b.instance_id WHERE a.id=NEW.predecessor_item_id AND ai.tenant_id=NEW.tenant_id AND bi.tenant_id=NEW.tenant_id AND ai.client_id<>bi.client_id) THEN RAISE EXCEPTION 'Invalid dependency scope'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.staff_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid dependency actor'; END IF;
 IF EXISTS(WITH RECURSIVE reachable(id) AS (SELECT successor_item_id FROM public.workflow_dependency WHERE predecessor_item_id=NEW.successor_item_id AND tenant_id=NEW.tenant_id UNION SELECT d.successor_item_id FROM public.workflow_dependency d JOIN reachable r ON d.predecessor_item_id=r.id WHERE d.tenant_id=NEW.tenant_id) SELECT 1 FROM reachable WHERE id=NEW.predecessor_item_id) THEN RAISE EXCEPTION 'Dependency cycle'; END IF;
 RETURN NEW;
END $function$;
