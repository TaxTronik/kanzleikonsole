CREATE OR REPLACE FUNCTION app.portal_inbox_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  batch_row public.portal_inbox_upload_batch;
  message_row public.portal_inbox_message;
  attachment_count INTEGER;
  attachment_size BIGINT;
  message_count INTEGER;
  calculated_manifest BYTEA;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.client client
    WHERE client.id = NEW.client_id AND client.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Portal-Inbox-Mandant gehört nicht zum Tenant-Scope'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_TABLE_NAME = 'portal_inbox_thread' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.created_by_contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Thread-Ersteller gehört nicht zum Mandanten';
    END IF;
    IF NEW.assigned_staff_id IS NOT NULL
       AND NOT app.portal_inbox_staff_recipient_access(
         NEW.tenant_id, NEW.assigned_staff_id, NEW.client_id
       ) THEN
      RAISE EXCEPTION 'Thread-Zuweisung vermittelt keinen Inbox-/Mandantenzugriff';
    END IF;
    IF NEW.resolved_by_staff_id IS NOT NULL
       AND NOT app.portal_inbox_staff_recipient_access(
         NEW.tenant_id, NEW.resolved_by_staff_id, NEW.client_id
       ) THEN
      RAISE EXCEPTION 'Thread-Abschluss gehört nicht zu berechtigtem Staff';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF app.current_actor_type() = 'CLIENT_CONTACT' AND (
        NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
        OR NEW.status <> 'OPEN'
        OR NEW.attention <> 'STAFF'
        OR NEW.assigned_staff_id IS NOT NULL
        OR NEW.resolved_at IS NOT NULL
        OR NEW.resolved_by_staff_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Portal-Kontakt darf nur einen eigenen offenen Thread erzeugen';
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

  ELSIF TG_TABLE_NAME = 'portal_inbox_message' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'Abgesendete Portal-Inbox-Nachrichten sind unveränderlich';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
        AND thread.status = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Nachricht benötigt einen offenen Thread desselben Scope';
    END IF;
    IF NEW.author_type = 'CLIENT_CONTACT' THEN
      IF app.current_actor_type() <> 'CLIENT_CONTACT'
         OR NEW.author_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id) THEN
        RAISE EXCEPTION 'Portal-Nachrichtenautor stimmt nicht mit der aktiven Session überein';
      END IF;
    ELSIF NEW.author_type = 'STAFF' THEN
      IF app.current_actor_type() <> 'STAFF'
         OR NEW.author_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_staff_access(NEW.tenant_id, NEW.client_id) THEN
        RAISE EXCEPTION 'Staff-Nachricht benötigt aktuelles Inbox-Recht und Mandantenzugriff';
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_upload_batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.created_by_contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Upload-Batch-Ersteller gehört nicht zum Mandanten';
    END IF;
    IF NEW.target_thread_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.target_thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
        AND thread.status = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Antwort-Batch benötigt einen offenen Zielthread';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF app.current_actor_type() <> 'CLIENT_CONTACT'
         OR NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
         OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
         OR NEW.status <> 'OPEN'
         OR NEW.expires_at > CURRENT_TIMESTAMP + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'Nur ein aktiver Portal-Kontakt darf einen eigenen 24h-Batch erzeugen';
      END IF;
    ELSE
      IF ROW(NEW.id, NEW.tenant_id, NEW.client_id, NEW.created_by_contact_id,
             NEW.purpose, NEW.target_thread_id, NEW.expires_at, NEW.created_at)
         IS DISTINCT FROM
         ROW(OLD.id, OLD.tenant_id, OLD.client_id, OLD.created_by_contact_id,
             OLD.purpose, OLD.target_thread_id, OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'Upload-Batch-Scope und Frist sind unveränderlich';
      END IF;
      IF OLD.status <> 'OPEN' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Terminaler Upload-Batch ist unveränderlich';
      END IF;
      IF app.current_actor_type() = 'CLIENT_CONTACT' THEN
        IF NEW.created_by_contact_id IS DISTINCT FROM app.current_actor_id()
           OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)
           OR NEW.status NOT IN ('OPEN', 'CONSUMED', 'DISCARDED') THEN
          RAISE EXCEPTION 'Portal-Kontakt darf nur eigenen offenen Batch finalisieren oder verwerfen';
        END IF;
      ELSIF app.current_actor_type() = 'SYSTEM' THEN
        IF NEW.status NOT IN ('OPEN', 'EXPIRED') THEN
          RAISE EXCEPTION 'Systempfad darf nur offene Batches ablaufen lassen';
        END IF;
      ELSE
        RAISE EXCEPTION 'Upload-Batch-Status ist nicht staffseitig änderbar';
      END IF;

      IF NEW.status = 'CONSUMED' AND OLD.status = 'OPEN' THEN
        SELECT count(*), COALESCE(sum(attachment.size_bytes), 0),
               count(DISTINCT attachment.message_id),
               public.digest(
                 string_agg(
                   attachment.position::TEXT || ':' || encode(attachment.sha256, 'hex') || ':'
                   || attachment.size_bytes::TEXT || ':'
                   || replace(encode(convert_to(attachment.mime_type, 'UTF8'), 'base64'), E'\n', '') || ':'
                   || replace(encode(convert_to(attachment.original_name, 'UTF8'), 'base64'), E'\n', ''),
                   E'\n' ORDER BY attachment.position
                 ),
                 'sha256'
               )
          INTO attachment_count, attachment_size, message_count, calculated_manifest
          FROM public.portal_inbox_attachment attachment
         WHERE attachment.batch_id = NEW.id;
        IF attachment_count < 1 OR attachment_count > 10
           OR attachment_size > 104857600
           OR message_count <> 1
           OR EXISTS (
             SELECT 1 FROM public.portal_inbox_attachment attachment
             WHERE attachment.batch_id = NEW.id
               AND (
                 attachment.message_id IS NULL
                 OR attachment.storage_version_id IS NULL
                 OR attachment.scan_status <> 'CLEAN'
                 OR attachment.decision <> 'PENDING_REVIEW'
               )
           )
           OR NEW.manifest_sha256 IS DISTINCT FROM calculated_manifest THEN
          RAISE EXCEPTION 'Batch-Manifest ist unvollständig, ungeprüft oder nicht hashgebunden';
        END IF;
        IF NEW.purpose = 'REPLY' AND EXISTS (
          SELECT 1 FROM public.portal_inbox_attachment attachment
          JOIN public.portal_inbox_message message ON message.id = attachment.message_id
          WHERE attachment.batch_id = NEW.id
            AND message.thread_id IS DISTINCT FROM NEW.target_thread_id
        ) THEN
          RAISE EXCEPTION 'Antwort-Batch wurde an einen anderen Thread gebunden';
        END IF;
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'portal_inbox_attachment' THEN
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
           OR NEW.message_id IS DISTINCT FROM OLD.message_id
           OR NEW.decision NOT IN ('ACCEPTED', 'REJECTED')
           OR NEW.decided_by_staff_id IS DISTINCT FROM app.current_actor_id()
           OR NEW.decided_at IS NULL THEN
          RAISE EXCEPTION 'Staff-Entscheidung benötigt aktuellen Scope und vollständige Provenienz';
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

  ELSIF TG_TABLE_NAME = 'portal_inbox_read' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_contact contact
      WHERE contact.id = NEW.contact_id
        AND contact.tenant_id = NEW.tenant_id
        AND contact.client_id = NEW.client_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.portal_inbox_thread thread
      WHERE thread.id = NEW.thread_id
        AND thread.tenant_id = NEW.tenant_id
        AND thread.client_id = NEW.client_id
    ) THEN
      RAISE EXCEPTION 'Lesestand gehört nicht zu Kontakt und Thread desselben Scope';
    END IF;
    IF app.current_actor_type() = 'CLIENT_CONTACT'
       AND (NEW.contact_id IS DISTINCT FROM app.current_actor_id()
            OR NOT app.portal_inbox_contact_access(NEW.tenant_id, NEW.client_id)) THEN
      RAISE EXCEPTION 'Portal-Kontakt darf nur eigenen Lesestand schreiben';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      ROW(NEW.tenant_id, NEW.client_id, NEW.thread_id, NEW.contact_id)
        IS DISTINCT FROM ROW(OLD.tenant_id, OLD.client_id, OLD.thread_id, OLD.contact_id)
      OR NEW.last_read_at < OLD.last_read_at
    ) THEN
      RAISE EXCEPTION 'Lesestand-Scope ist unveränderlich und monoton';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
