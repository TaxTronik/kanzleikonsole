-- Fachkatalog: PORTAL-INBOX-SUBMISSION-001, ACCESS-TENANT-RLS-001,
-- ACCESS-STAFF-PERMISSION-001, DOC-UPLOAD-JOURNAL-001.
--
-- Portal-Threads werden bei genau einem aktuell berechtigten Hauptbearbeiter
-- serverseitig geroutet. Außerdem darf eine wiederaufnehmbare Übernahme das
-- erzeugte PENDING-Dokument am Inbox-Anhang reservieren, bevor Object-Commit
-- und Finalisierung abgeschlossen sind.

CREATE FUNCTION app.portal_inbox_unique_assignee(
  p_tenant_id UUID,
  p_client_id UUID
) RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(candidate.staff_id))[1] ELSE NULL END
  FROM (
    SELECT DISTINCT responsibility.staff_id
    FROM public.client_responsibility responsibility
    WHERE responsibility.tenant_id = p_tenant_id
      AND responsibility.client_id = p_client_id
      AND responsibility.role = 'HAUPTBEARBEITER'
      AND app.portal_inbox_staff_recipient_access(
        p_tenant_id,
        responsibility.staff_id,
        p_client_id
      )
  ) candidate
$$;

REVOKE ALL ON FUNCTION app.portal_inbox_unique_assignee(UUID, UUID)
  FROM PUBLIC, taxtronik_app;

CREATE FUNCTION app.portal_inbox_thread_guard_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
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

      -- Der Portal-Write kann keinen Staff bestimmen. Die DB überschreibt
      -- jeden übergebenen Wert mit dem aktuell eindeutig berechtigten
      -- Hauptbearbeiter oder NULL für den Teamkorb.
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
    IF app.current_actor_type() = 'CLIENT_CONTACT' AND (
      ROW(NEW.subject, NEW.topic, NEW.status, NEW.assigned_staff_id,
          NEW.resolved_at, NEW.resolved_by_staff_id)
      IS DISTINCT FROM
      ROW(OLD.subject, OLD.topic, OLD.status, OLD.assigned_staff_id,
          OLD.resolved_at, OLD.resolved_by_staff_id)
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

DROP TRIGGER portal_inbox_thread_guard ON public.portal_inbox_thread;
CREATE TRIGGER portal_inbox_thread_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_thread
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_thread_guard_v2();

ALTER TABLE public.portal_inbox_attachment
  DROP CONSTRAINT portal_inbox_attachment_decision_check;
ALTER TABLE public.portal_inbox_attachment
  ADD CONSTRAINT portal_inbox_attachment_decision_check CHECK (
    (
      decision = 'PENDING_REVIEW'
      AND scan_status <> 'BLOCKED'
      AND decided_by_staff_id IS NULL
      AND decided_at IS NULL
      AND rejection_reason IS NULL
    )
    OR
    (
      decision = 'ACCEPTED'
      AND scan_status = 'CLEAN'
      AND accepted_document_id IS NOT NULL
      AND decided_by_staff_id IS NOT NULL
      AND decided_at IS NOT NULL
      AND rejection_reason IS NULL
    )
    OR
    (
      decision = 'REJECTED'
      AND scan_status = 'CLEAN'
      AND accepted_document_id IS NULL
      AND decided_by_staff_id IS NOT NULL
      AND decided_at IS NOT NULL
      AND length(btrim(rejection_reason)) > 0
    )
    OR
    (
      decision = 'BLOCKED'
      AND scan_status = 'BLOCKED'
      AND accepted_document_id IS NULL
      AND decided_by_staff_id IS NULL
      AND decided_at IS NULL
    )
  );

CREATE FUNCTION app.portal_inbox_attachment_guard_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
DECLARE
  batch_row public.portal_inbox_upload_batch;
  message_row public.portal_inbox_message;
  attachment_count INTEGER;
  attachment_size BIGINT;
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

  SELECT * INTO batch_row
    FROM public.portal_inbox_upload_batch batch
   WHERE batch.id = NEW.batch_id
     AND batch.tenant_id = NEW.tenant_id
     AND batch.client_id = NEW.client_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anhang benötigt einen Batch desselben Scope';
  END IF;
  IF NEW.storage_key NOT LIKE 'tenants/' || NEW.tenant_id::TEXT || '/%' THEN
    RAISE EXCEPTION 'Staging-Key liegt nicht im Tenant-Präfix';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF batch_row.status <> 'OPEN' OR batch_row.expires_at <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'Anhang benötigt einen aktiven offenen Batch';
    END IF;
    IF app.current_actor_type() <> 'CLIENT_CONTACT'
       OR batch_row.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
       OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
       OR NEW.scan_status <> 'PENDING'
       OR NEW.storage_version_id IS NOT NULL
       OR NEW.decision <> 'PENDING_REVIEW'
       OR NEW.message_id IS NOT NULL
       OR NEW.accepted_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'Anhang muss als eigener PENDING-Staging-Intent beginnen';
    END IF;
    SELECT count(*), COALESCE(sum(attachment.size_bytes), 0)
      INTO attachment_count, attachment_size
      FROM public.portal_inbox_attachment attachment
     WHERE attachment.batch_id = NEW.batch_id;
    IF attachment_count >= 10 OR attachment_size + NEW.size_bytes > 104857600 THEN
      RAISE EXCEPTION 'Upload-Batch überschreitet Datei- oder Größenlimit';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.batch_id,
           NEW.original_name, NEW.mime_type, NEW.storage_bucket,
           NEW.storage_key, NEW.sha256, NEW.size_bytes, NEW.position,
           NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.batch_id,
           OLD.original_name, OLD.mime_type, OLD.storage_bucket,
           OLD.storage_key, OLD.sha256, OLD.size_bytes, OLD.position,
           OLD.created_at) THEN
      RAISE EXCEPTION 'Staging- und Byteidentität des Anhangs ist unveränderlich';
    END IF;
    IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
      RAISE EXCEPTION 'Nachrichtenbindung des Anhangs ist unveränderlich';
    END IF;
    IF OLD.decision <> 'PENDING_REVIEW' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Getroffene Anhangsentscheidung ist unveränderlich';
    END IF;

    IF app.current_actor_type() = 'CLIENT_CONTACT' THEN
      IF batch_row.status <> 'OPEN'
         OR batch_row.expires_at <= CURRENT_TIMESTAMP
         OR batch_row.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
         OR NEW.accepted_document_id IS DISTINCT FROM OLD.accepted_document_id
         OR NEW.decided_by_staff_id IS DISTINCT FROM OLD.decided_by_staff_id
         OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
         OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason THEN
        RAISE EXCEPTION 'Portal-Kontakt darf nur seinen offenen Staging-Anhang finalisieren oder binden';
      END IF;
      IF OLD.scan_status <> 'PENDING'
         AND ROW(NEW.scan_status, NEW.storage_version_id, NEW.decision)
           IS DISTINCT FROM ROW(OLD.scan_status, OLD.storage_version_id, OLD.decision) THEN
        RAISE EXCEPTION 'Scannergebnis ist terminal';
      END IF;
      IF OLD.scan_status = 'PENDING'
         AND NEW.scan_status NOT IN ('PENDING', 'CLEAN', 'BLOCKED') THEN
        RAISE EXCEPTION 'Unzulässiger Scanübergang';
      END IF;
      IF NEW.scan_status = 'BLOCKED' THEN
        NEW.decision := 'BLOCKED';
      ELSIF NEW.decision <> 'PENDING_REVIEW' THEN
        RAISE EXCEPTION 'Portal-Kontakt trifft keine Kanzleientscheidung';
      END IF;
      IF NEW.message_id IS NOT NULL AND OLD.message_id IS NULL THEN
        IF NEW.scan_status <> 'CLEAN' OR NEW.storage_version_id IS NULL THEN
          RAISE EXCEPTION 'Nur sauber abgeschlossene Anhänge dürfen abgesendet werden';
        END IF;
        SELECT * INTO message_row
          FROM public.portal_inbox_message message
         WHERE message.id = NEW.message_id
           AND message.tenant_id = NEW.tenant_id
           AND message.client_id = NEW.client_id;
        IF NOT FOUND OR message_row.author_type <> 'CLIENT_CONTACT'
           OR message_row.author_id IS DISTINCT FROM app.current_actor_id()
           OR (batch_row.purpose = 'REPLY'
               AND message_row.thread_id IS DISTINCT FROM batch_row.target_thread_id) THEN
          RAISE EXCEPTION 'Anhang darf nur an die eigene passende Nachricht gebunden werden';
        END IF;
      END IF;
    ELSIF app.current_actor_type() = 'STAFF' THEN
      IF NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id)
         OR batch_row.status <> 'CONSUMED'
         OR NEW.message_id IS NULL
         OR NEW.scan_status IS DISTINCT FROM OLD.scan_status
         OR NEW.storage_version_id IS DISTINCT FROM OLD.storage_version_id
         OR NEW.message_id IS DISTINCT FROM OLD.message_id THEN
        RAISE EXCEPTION 'Staff-Entscheidung benötigt aktuellen Scope und vollständige Provenienz';
      END IF;

      IF NEW.decision = 'PENDING_REVIEW' THEN
        IF OLD.decision <> 'PENDING_REVIEW'
           OR OLD.accepted_document_id IS NOT NULL
           OR NEW.accepted_document_id IS NULL
           OR NEW.decided_by_staff_id IS DISTINCT FROM OLD.decided_by_staff_id
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
           OR NOT EXISTS (
             SELECT 1
             FROM public.document document
             JOIN public.document_version version ON version.document_id = document.id
             WHERE document.id = NEW.accepted_document_id
               AND document.tenant_id = NEW.tenant_id
               AND document.client_id = NEW.client_id
               AND document.deleted_at IS NULL
               AND document.shared_with_client_at IS NULL
               AND version.sha256 = NEW.sha256
               AND version.scan_status = 'PENDING'
               AND version.scan_completed_at IS NULL
           ) THEN
          RAISE EXCEPTION 'PENDING-Übernahme benötigt ein passendes resumierbares Dokument';
        END IF;
      ELSIF NEW.decision IN ('ACCEPTED', 'REJECTED') THEN
        IF NEW.decided_by_staff_id IS DISTINCT FROM app.current_actor_id()
           OR NEW.decided_at IS NULL THEN
          RAISE EXCEPTION 'Staff-Entscheidung muss dem handelnden Staff zugeordnet sein';
        END IF;
      ELSE
        RAISE EXCEPTION 'Staff darf nur übernehmen oder neutral ablehnen';
      END IF;
    ELSIF app.current_actor_type() = 'SYSTEM' THEN
      IF OLD.scan_status <> 'PENDING'
         OR NEW.scan_status NOT IN ('CLEAN', 'BLOCKED')
         OR NEW.message_id IS DISTINCT FROM OLD.message_id
         OR NEW.accepted_document_id IS DISTINCT FROM OLD.accepted_document_id
         OR NEW.decided_by_staff_id IS DISTINCT FROM OLD.decided_by_staff_id
         OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
        RAISE EXCEPTION 'Systempfad darf nur ein offenes Scannergebnis abschließen';
      END IF;
      IF NEW.scan_status = 'BLOCKED' THEN NEW.decision := 'BLOCKED'; END IF;
    ELSE
      RAISE EXCEPTION 'Unzulässiger Akteur für Portal-Inbox-Anhang';
    END IF;

    IF NEW.decision = 'ACCEPTED' AND NOT EXISTS (
      SELECT 1
      FROM public.document document
      JOIN public.document_version version ON version.document_id = document.id
      WHERE document.id = NEW.accepted_document_id
        AND document.tenant_id = NEW.tenant_id
        AND document.client_id = NEW.client_id
        AND document.deleted_at IS NULL
        AND document.shared_with_client_at IS NULL
        AND version.sha256 = NEW.sha256
        AND version.scan_status = 'CLEAN'
    ) THEN
      RAISE EXCEPTION 'Angenommenes Archivdokument stimmt nicht mit sauberem Staging-Original überein';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.portal_inbox_attachment_guard_v2()
  FROM PUBLIC, taxtronik_app;

DROP TRIGGER portal_inbox_attachment_guard ON public.portal_inbox_attachment;
CREATE TRIGGER portal_inbox_attachment_guard
  BEFORE INSERT OR UPDATE ON public.portal_inbox_attachment
  FOR EACH ROW EXECUTE FUNCTION app.portal_inbox_attachment_guard_v2();
