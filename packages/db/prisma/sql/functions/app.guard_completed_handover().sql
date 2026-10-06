CREATE OR REPLACE FUNCTION app.guard_completed_handover()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF OLD.completed_at IS NOT NULL OR (NEW.tenant_id,NEW.client_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.client_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'handover identity or completed state is immutable'; END IF;
 IF NEW.completed_at IS NOT NULL AND (to_jsonb(NEW)-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at') THEN RAISE EXCEPTION 'completion cannot replace the reviewed source'; END IF;
 RETURN NEW;
END $function$;
