-- Fachkatalog: PORTAL-INBOX-SUBMISSION-001, ACCESS-STAFF-PERMISSION-001,
-- ACCESS-NOTIFICATION-RECIPIENT-001.
--
-- Wird der bisherige Bearbeiter zwischen zwei Mandantennachrichten inaktiv
-- oder verliert Recht/Mandantenzugriff, darf die Message-Projektion nicht am
-- stale Assignee scheitern. Der Guard routet ausschließlich in diesem Fall
-- erneut auf genau einen aktuell berechtigten Hauptbearbeiter oder Team/null.

CREATE OR REPLACE FUNCTION app.portal_inbox_thread_guard_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
DECLARE
  portal_assignment_refresh BOOLEAN := FALSE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.client client
    WHERE client.id = NEW.client_id
      AND client.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Portal-Inbox-Mandant gehört nicht zum Tenant-Scope'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.client_contact contact
    WHERE contact.id = NEW.created_by_contact_id
      AND contact.tenant_id = NEW.tenant_id
      AND contact.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION 'Thread-Ersteller gehört nicht zum Mandanten';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF app.current_actor_type() = 'CLIENT_CONTACT' THEN
      IF NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
         OR NEW.status <> 'OPEN'
         OR NEW.attention <> 'STAFF'
         OR NEW.resolved_at IS NOT NULL
         OR NEW.resolved_by_staff_id IS NOT NULL THEN
        RAISE EXCEPTION 'Portal-Kontakt darf nur einen eigenen offenen Thread erzeugen';
      END IF;
      NEW.assigned_staff_id := app.portal_inbox_unique_assignee(
        NEW.tenant_id,
        NEW.client_id
      );
    ELSIF app.current_actor_type() = 'STAFF' THEN
      RAISE EXCEPTION 'Neue Portal-Inbox-Threads werden mandantenseitig initiiert';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.created_by_contact_id, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.created_by_contact_id, OLD.created_at) THEN
      RAISE EXCEPTION 'Portal-Inbox-Thread-Scope ist unveränderlich';
    END IF;
    IF NEW.last_message_at < OLD.last_message_at THEN
      RAISE EXCEPTION 'Thread-Zeit darf nicht zurückgesetzt werden';
    END IF;

    IF app.current_actor_type() = 'CLIENT_CONTACT'
       AND OLD.assigned_staff_id IS NOT NULL
       AND NOT app.portal_inbox_staff_recipient_access(
         OLD.tenant_id,
         OLD.assigned_staff_id,
         OLD.client_id
       ) THEN
      NEW.assigned_staff_id := app.portal_inbox_unique_assignee(
        NEW.tenant_id,
        NEW.client_id
      );
      portal_assignment_refresh := TRUE;
    END IF;

    IF app.current_actor_type() = 'CLIENT_CONTACT' AND (
      ROW(NEW.subject, NEW.topic, NEW.status,
          NEW.resolved_at, NEW.resolved_by_staff_id)
      IS DISTINCT FROM
      ROW(OLD.subject, OLD.topic, OLD.status,
          OLD.resolved_at, OLD.resolved_by_staff_id)
      OR (
        NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id
        AND NOT portal_assignment_refresh
      )
      OR NEW.attention <> 'STAFF'
    ) THEN
      RAISE EXCEPTION 'Portal-Kontakt darf Thread-Metadaten nicht umdeuten';
    END IF;
    IF app.current_actor_type() = 'STAFF'
       AND NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id) THEN
      RAISE EXCEPTION 'Portal-Inbox-Recht und Mandantenzugriff erforderlich';
    END IF;
    IF app.current_actor_type() = 'STAFF'
       AND NEW.status = 'RESOLVED'
       AND OLD.status <> 'RESOLVED'
       AND NEW.resolved_by_staff_id IS DISTINCT FROM app.current_actor_id() THEN
      RAISE EXCEPTION 'Thread-Abschluss muss dem handelnden Staff zugeordnet sein';
    END IF;
  END IF;

  IF NEW.assigned_staff_id IS NOT NULL
     AND NOT app.portal_inbox_staff_recipient_access(
       NEW.tenant_id,
       NEW.assigned_staff_id,
       NEW.client_id
     ) THEN
    RAISE EXCEPTION 'Thread-Zuweisung vermittelt keinen Inbox-/Mandantenzugriff';
  END IF;
  IF NEW.resolved_by_staff_id IS NOT NULL
     AND NOT app.portal_inbox_staff_recipient_access(
       NEW.tenant_id,
       NEW.resolved_by_staff_id,
       NEW.client_id
     ) THEN
    RAISE EXCEPTION 'Thread-Abschluss gehört nicht zu berechtigtem Staff';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.portal_inbox_thread_guard_v2()
  FROM PUBLIC, taxtronik_app;
