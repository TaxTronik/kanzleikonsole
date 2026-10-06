CREATE OR REPLACE FUNCTION app.upsert_client_contact_notification(p_tenant_id uuid, p_client_id uuid, p_staff_id uuid, p_kind public.notification_kind, p_title text, p_body text, p_href text, p_resource_type text, p_resource_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  contact_client_id UUID;
  lock_key TEXT;
  scope RECORD;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'CLIENT_CONTACT'
     OR app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Nur ein tenantgebundener Portal-Kontakt darf Staff-Notifications erzeugen'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT contact."client_id" INTO contact_client_id
    FROM public."client_contact" contact
   WHERE contact."id" = app.current_actor_id()
     AND contact."tenant_id" = p_tenant_id
     AND contact."active" = TRUE
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aktiver Portal-Kontakt nicht gefunden'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_client_id IS NOT NULL
     AND p_client_id IS DISTINCT FROM contact_client_id THEN
    RAISE EXCEPTION 'Notification-Mandant widerspricht dem Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Geschlossene Positivliste der heute clientseitig erzeugten Ereignisse.
  -- Neue Portal-Producer müssen bewusst klassifiziert und getestet werden.
  IF NOT (
    (p_kind = 'APPOINTMENT_REQUESTED' AND p_resource_type = 'appointment_request')
    OR (p_kind = 'REQUEST_RESPONDED' AND p_resource_type = 'request')
    OR (
      p_kind = 'CLIENT_MASTER_CHANGE_REQUEST'
      AND p_resource_type = 'client_master_change_request'
    )
    OR (
      p_kind = 'GWG_ONBOARDING_SUBMITTED'
      AND p_resource_type = 'gwg_onboarding_invite'
    )
  ) THEN
    RAISE EXCEPTION 'Nicht freigegebene Portal-Notification (%:%)',
      p_kind, p_resource_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO scope
    FROM app.notification_resource_scope(
      p_tenant_id,
      p_resource_type,
      p_resource_id
    );
  IF NOT scope.resource_is_known
     OR NOT scope.resource_was_found
     OR scope.resolved_client_id IS DISTINCT FROM contact_client_id THEN
    RAISE EXCEPTION 'Notification-Ressource gehört nicht zum Portal-Mandanten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public."staff_user" staff
     WHERE staff."id" = p_staff_id
       AND staff."tenant_id" = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Notification-Empfänger gehört nicht zum Tenant-Scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  lock_key := 'notify:' || p_tenant_id::TEXT
    || ':' || COALESCE(p_staff_id::TEXT, '')
    || ':' || p_kind::TEXT
    || ':' || COALESCE(p_resource_type, '')
    || ':' || COALESCE(p_resource_id, '');
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(lock_key, 0)
  );

  -- Der Schlüssel beweist keine Provenienz. Eine gleichartige interne
  -- Staff-/System-Notification darf ein Portal-Kontakt deshalb weder ersetzen
  -- noch zeitlich aktualisieren. TRUE ist in beiden Zweigen konstant, damit
  -- die Funktion kein Existenz-Orakel für unsichtbare Hinweise bildet.
  IF EXISTS (
    SELECT 1
      FROM public."notification" notification
     WHERE notification."tenant_id" = p_tenant_id
       AND notification."client_id" = contact_client_id
       AND notification."staff_id" IS NOT DISTINCT FROM p_staff_id
       AND notification."kind" = p_kind
       AND notification."resource_type" IS NOT DISTINCT FROM p_resource_type
       AND notification."resource_id" IS NOT DISTINCT FROM p_resource_id
       AND notification."read_at" IS NULL
  ) THEN
    RETURN TRUE;
  END IF;

  INSERT INTO public."notification" (
    "tenant_id",
    "client_id",
    "staff_id",
    "kind",
    "title",
    "body",
    "href",
    "resource_type",
    "resource_id"
  ) VALUES (
    p_tenant_id,
    contact_client_id,
    p_staff_id,
    p_kind,
    p_title,
    p_body,
    p_href,
    p_resource_type,
    p_resource_id
  );
  RETURN TRUE;
END;
$function$;
