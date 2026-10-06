CREATE OR REPLACE FUNCTION app.notify_portal_inbox_activity(p_tenant_id uuid, p_thread_id uuid, p_staff_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  contact_client_id UUID;
  thread_client_id UUID;
  lock_key TEXT;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'
     OR app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Nur ein tenantgebundener Portal-Kontakt darf Inbox-Hinweise erzeugen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT contact.client_id INTO contact_client_id
    FROM public.client_contact contact
   WHERE contact.id = app.current_actor_id()
     AND contact.tenant_id = p_tenant_id
     AND contact.active
   FOR SHARE;
  IF NOT FOUND OR NOT app.portal_inbox_contact_access(p_tenant_id, contact_client_id) THEN
    RAISE EXCEPTION 'Aktiver Portal-Inbox-Kontakt nicht gefunden'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT thread.client_id INTO thread_client_id
    FROM public.portal_inbox_thread thread
   WHERE thread.id = p_thread_id
     AND thread.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR thread_client_id IS DISTINCT FROM contact_client_id THEN
    RAISE EXCEPTION 'Inbox-Thread gehört nicht zum Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_staff_id IS NULL OR NOT app.portal_inbox_staff_recipient_access(
    p_tenant_id,
    p_staff_id,
    thread_client_id
  ) THEN
    RAISE EXCEPTION 'Inbox-Notification-Empfänger besitzt keinen aktuellen Zugriff'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  lock_key := 'notify-portal-inbox:' || p_tenant_id::TEXT || ':'
    || p_staff_id::TEXT || ':' || p_thread_id::TEXT;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lock_key, 0)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.notification notification
    WHERE notification.tenant_id = p_tenant_id
      AND notification.client_id = thread_client_id
      AND notification.staff_id = p_staff_id
      AND notification.kind = 'PORTAL_INBOX_ACTIVITY'
      AND notification.resource_type = 'portal_inbox_thread'
      AND notification.resource_id = p_thread_id::TEXT
      AND notification.read_at IS NULL
  ) THEN
    INSERT INTO public.notification (
      tenant_id,
      client_id,
      staff_id,
      kind,
      title,
      body,
      href,
      resource_type,
      resource_id
    ) VALUES (
      p_tenant_id,
      thread_client_id,
      p_staff_id,
      'PORTAL_INBOX_ACTIVITY',
      'Neue Mandantenpost',
      NULL,
      '/staff/inbox/' || p_thread_id::TEXT,
      'portal_inbox_thread',
      p_thread_id::TEXT
    );
  END IF;

  RETURN TRUE;
END;
$function$;
