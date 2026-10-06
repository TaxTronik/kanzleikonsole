CREATE OR REPLACE FUNCTION app.guard_inbound_mailbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF app.current_actor_type()='STAFF' AND NOT EXISTS(SELECT 1 FROM public.staff_role r JOIN public.staff_user s ON s.id=r.staff_user_id WHERE s.id=app.current_actor_id() AND s.tenant_id=NEW.tenant_id AND s.active AND r.role IN ('ADMIN','PARTNER')) THEN RAISE EXCEPTION 'mailbox administration required'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.provider,NEW.host,NEW.port,NEW.username,NEW.folder,NEW.entra_tenant_id,NEW.entra_client_id) IS DISTINCT FROM (OLD.tenant_id,OLD.provider,OLD.host,OLD.port,OLD.username,OLD.folder,OLD.entra_tenant_id,OLD.entra_client_id) THEN RAISE EXCEPTION 'mailbox identity is immutable; create a new profile'; END IF;
 RETURN NEW;
END $function$;
