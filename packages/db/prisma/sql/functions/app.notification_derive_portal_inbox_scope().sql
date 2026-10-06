CREATE OR REPLACE FUNCTION app.notification_derive_portal_inbox_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  expected_client_id UUID;
  staff_tenant_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
    OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
  ) THEN
    RAISE EXCEPTION 'Notification-Scope und Ressourcenlink sind unveränderlich'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT thread.client_id INTO expected_client_id
    FROM public.portal_inbox_thread thread
   WHERE thread.tenant_id = NEW.tenant_id
     AND thread.id::TEXT = NEW.resource_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bekannte Notification-Ressource existiert nicht im Tenant-Scope (%:%)',
      NEW.resource_type, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM expected_client_id THEN
    RAISE EXCEPTION 'Notification.client_id widerspricht dem bekannten Inbox-Thread'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.client_id := expected_client_id;

  IF NEW.staff_id IS NOT NULL THEN
    SELECT staff.tenant_id INTO staff_tenant_id
      FROM public.staff_user staff
     WHERE staff.id = NEW.staff_id
     FOR KEY SHARE;
    IF NOT FOUND OR staff_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Notification.staff_id gehört nicht zum Tenant-Scope'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
