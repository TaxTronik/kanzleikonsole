-- PORTAL-INBOX-SUBMISSION-001 / ACCESS-NOTIFICATION-RECIPIENT-001
-- Der Portalakteur übergibt weder Titel, Body noch Link. Der dedizierte
-- write-only Pfad erzeugt ausschließlich einen generischen, aktuell
-- berechtigungsgebundenen Mitarbeiterhinweis.
BEGIN;

CREATE OR REPLACE FUNCTION app.notification_resource_scope(
  p_tenant_id UUID,
  p_resource_type TEXT,
  p_resource_id TEXT,
  OUT resource_is_known BOOLEAN,
  OUT resource_was_found BOOLEAN,
  OUT resolved_client_id UUID
) RETURNS RECORD
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF app.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    resource_is_known := FALSE;
    resource_was_found := FALSE;
    resolved_client_id := NULL;
    RETURN;
  END IF;

  resource_is_known := TRUE;
  resource_was_found := FALSE;
  resolved_client_id := NULL;

  IF p_resource_type IS NULL AND p_resource_id IS NULL THEN
    resource_was_found := TRUE;
    RETURN;
  ELSIF p_resource_type IS NULL THEN
    resource_is_known := FALSE;
    RETURN;
  END IF;

  CASE p_resource_type
    WHEN 'tax_notice' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.tax_notice source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client_reminder' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_reminder source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'pending_binder' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.pending_binder source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'tax_deadline' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.tax_deadline source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'invoice' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.invoice source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'gwg_check' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.gwg_check source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'power_of_attorney' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.power_of_attorney source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'phone_note' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.phone_note source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client' THEN
      SELECT source.id INTO resolved_client_id
        FROM public.client source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'document' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.document source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'appointment' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.appointment source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'appointment_request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.appointment_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client_master_change_request' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_master_change_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client_contact' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_contact source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client_consent' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.client_consent source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'client_reminder_note' THEN
      SELECT reminder.client_id INTO resolved_client_id
        FROM public.client_reminder_note note
        JOIN public.client_reminder reminder
          ON reminder.id = note.reminder_id
         AND reminder.tenant_id = note.tenant_id
       WHERE note.tenant_id = p_tenant_id
         AND note.id::TEXT = p_resource_id;
    WHEN 'gwg_onboarding_invite' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.gwg_onboarding_invite source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'gwg_id_document' THEN
      SELECT check_row.client_id INTO resolved_client_id
        FROM public.gwg_id_document id_document
        JOIN public.gwg_check check_row
          ON check_row.id = id_document.gwg_check_id
       WHERE check_row.tenant_id = p_tenant_id
         AND id_document.id::TEXT = p_resource_id;
    WHEN 'risk_marking' THEN
      SELECT analysis.client_id INTO resolved_client_id
        FROM public.risk_marking marking
        JOIN public.risk_analysis analysis
          ON analysis.id = marking.analysis_id
         AND analysis.tenant_id = marking.tenant_id
       WHERE marking.tenant_id = p_tenant_id
         AND marking.id::TEXT = p_resource_id;
    WHEN 'risk_research_result' THEN
      SELECT COALESCE(
        request_analysis.client_id,
        marking_analysis.client_id,
        shelf.client_id
      ) INTO resolved_client_id
        FROM public.risk_research_result result
        LEFT JOIN public.risk_research_request research_request
          ON research_request.id = result.research_request_id
         AND research_request.tenant_id = result.tenant_id
        LEFT JOIN public.risk_analysis request_analysis
          ON request_analysis.id = research_request.analysis_id
         AND request_analysis.tenant_id = result.tenant_id
        LEFT JOIN public.risk_marking marking
          ON marking.id = result.marking_id
         AND marking.tenant_id = result.tenant_id
        LEFT JOIN public.risk_analysis marking_analysis
          ON marking_analysis.id = marking.analysis_id
         AND marking_analysis.tenant_id = result.tenant_id
        LEFT JOIN public.document shelf
          ON shelf.id = result.shelf_document_id
         AND shelf.tenant_id = result.tenant_id
       WHERE result.tenant_id = p_tenant_id
         AND result.id::TEXT = p_resource_id;
    WHEN 'portal_inbox_thread' THEN
      SELECT source.client_id INTO resolved_client_id
        FROM public.portal_inbox_thread source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'vacation_request' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.vacation_request source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'absence' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.absence source
       WHERE source.tenant_id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'tenant' THEN
      SELECT NULL::UUID INTO resolved_client_id
        FROM public.tenant source
       WHERE source.id = p_tenant_id
         AND source.id::TEXT = p_resource_id;
    WHEN 'audit_log', 'backup_drill', 'mail', 'staff_user', 'tax_news_item' THEN
      resource_was_found := TRUE;
      RETURN;
    ELSE
      resource_is_known := FALSE;
      RETURN;
  END CASE;

  resource_was_found := FOUND;
END;
$$;

-- Portalparameter enthalten ausschließlich Scope-IDs. Titel, Body, Link,
-- Clientzuordnung und NotificationKind werden in der Datenbank festgelegt.
CREATE FUNCTION app.notify_portal_inbox_activity(
  p_tenant_id UUID,
  p_thread_id UUID,
  p_staff_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
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
$$;

-- Auch Staff-/System-Producer können keine Nachrichtentexte oder Dateinamen
-- in diesen Hinweis schreiben und keinen unberechtigten Empfänger wählen.
CREATE FUNCTION app.portal_inbox_notification_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
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
$$;
CREATE TRIGGER "10_portal_inbox_notification_guard"
  BEFORE INSERT OR UPDATE ON public.notification
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_notification_guard();

-- Restriktive Policy wird mit den vorhandenen permissiven Policies verundet.
-- Ein später entzogener Inbox-Grant blendet vorhandene Hinweise sofort aus.
CREATE POLICY notification_portal_inbox_permission
  ON public.notification
  AS RESTRICTIVE
  FOR ALL
  TO taxtronik_app
  USING (
    kind <> 'PORTAL_INBOX_ACTIVITY'
    OR app.current_actor_type() = 'SYSTEM'
    OR (
      app.current_actor_type() = 'STAFF'
      AND staff_id = app.current_actor_id()
      AND client_id IS NOT NULL
      AND app.portal_inbox_staff_access(tenant_id, client_id)
    )
  )
  WITH CHECK (
    kind <> 'PORTAL_INBOX_ACTIVITY'
    OR app.current_actor_type() = 'SYSTEM'
    OR (
      app.current_actor_type() = 'STAFF'
      AND client_id IS NOT NULL
      AND app.portal_inbox_staff_access(tenant_id, client_id)
    )
  );

REVOKE ALL ON FUNCTION app.notify_portal_inbox_activity(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notify_portal_inbox_activity(UUID, UUID, UUID) TO taxtronik_app;
REVOKE ALL ON FUNCTION app.portal_inbox_notification_guard() FROM PUBLIC, taxtronik_app;

COMMIT;
