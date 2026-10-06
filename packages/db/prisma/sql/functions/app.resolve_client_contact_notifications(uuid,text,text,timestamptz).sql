CREATE OR REPLACE FUNCTION app.resolve_client_contact_notifications(p_tenant_id uuid, p_resource_type text, p_resource_id text, p_resolved_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  contact_client_id UUID;
  scope RECORD;
  resolved_count INTEGER;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'
     OR app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Nur ein tenantgebundener Portal-Kontakt darf diese Notification-Auflösung ausführen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT contact."client_id" INTO contact_client_id
    FROM public."client_contact" contact
   WHERE contact."id" = app.current_actor_id()
     AND contact."tenant_id" = p_tenant_id
     AND contact."active" = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aktiver Portal-Kontakt nicht gefunden'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO scope
    FROM app.notification_resource_scope(p_tenant_id, p_resource_type, p_resource_id);
  IF NOT scope.resource_is_known
     OR NOT scope.resource_was_found
     OR scope.resolved_client_id IS DISTINCT FROM contact_client_id THEN
    RAISE EXCEPTION 'Notification-Ressource gehört nicht zum Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public."notification"
     SET "read_at" = p_resolved_at
   WHERE "tenant_id" = p_tenant_id
     AND "client_id" = contact_client_id
     AND "resource_type" = p_resource_type
     AND "resource_id" = p_resource_id
     AND "read_at" IS NULL;
  GET DIAGNOSTICS resolved_count = ROW_COUNT;
  RETURN resolved_count;
END;
$function$;
