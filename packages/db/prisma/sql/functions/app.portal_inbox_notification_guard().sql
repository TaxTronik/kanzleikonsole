CREATE OR REPLACE FUNCTION app.portal_inbox_notification_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.kind = 'PORTAL_INBOX_ACTIVITY' THEN
    IF NEW.resource_type IS DISTINCT FROM 'portal_inbox_thread'
       OR NEW.resource_id IS NULL
       OR NEW.client_id IS NULL
       OR NEW.staff_id IS NULL
       OR NOT app.portal_inbox_staff_recipient_access(
         NEW.tenant_id,
         NEW.staff_id,
         NEW.client_id
       ) THEN
      RAISE EXCEPTION 'Portal-Inbox-Hinweis benötigt Thread und aktuell berechtigten Empfänger'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.title := 'Neue Mandantenpost';
    NEW.body := NULL;
    NEW.href := '/staff/inbox/' || NEW.resource_id;
  END IF;
  RETURN NEW;
END;
$function$;
