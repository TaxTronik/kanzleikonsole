-- Fachkatalog: PORTAL-INBOX-SUBMISSION-001, DOC-UPLOAD-JOURNAL-001,
-- DOC-VERSION-IMMUTABILITY-001, ACCESS-TENANT-RLS-001,
-- ACCESS-STAFF-PERMISSION-001.
--
-- Eine unterbrochene Inbox-Anlagenannahme darf abgelehnt werden, ohne das
-- resumierbare PENDING-Dokument unsichtbar zurueckzulassen. Der enge
-- SECURITY-DEFINER-Pfad prueft Provenienz und Scope erneut, journalisiert die
-- feste Storage-Identitaet und entfernt ausschliesslich die noch nicht
-- finalisierte Ein-Version-Reservierung atomar mit der Ablehnung.

CREATE FUNCTION app.reject_pending_portal_inbox_attachment(
  p_attachment_id UUID,
  p_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app, pg_temp
SET row_security = off
AS $$
DECLARE
  attachment_row public.portal_inbox_attachment%ROWTYPE;
  document_row public.document%ROWTYPE;
  version_row public.document_version%ROWTYPE;
  orphan_row public.storage_orphan%ROWTYPE;
  version_count INTEGER;
  orphan_count INTEGER;
  affected_count INTEGER;
BEGIN
  IF app.current_tenant_id() IS NULL
     OR app.current_actor_type() IS DISTINCT FROM 'STAFF'
     OR app.current_actor_id() IS NULL THEN
    RAISE EXCEPTION 'Reservierte Inbox-Annahme darf nur im Staff-Kontext abgebrochen werden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reason NOT IN ('NOT_REQUIRED', 'DUPLICATE', 'UNSUPPORTED', 'OTHER') THEN
    RAISE EXCEPTION 'Unzulaessiger neutraler Ablehnungsgrund.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT attachment.* INTO attachment_row
    FROM public.portal_inbox_attachment attachment
   WHERE attachment.id = p_attachment_id
     AND attachment.tenant_id = app.current_tenant_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbox-Anlage nicht gefunden.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT app.portal_inbox_staff_access(
       attachment_row.tenant_id,
       attachment_row.client_id
     )
     OR NOT EXISTS (
       SELECT 1
         FROM public.tenant_setting setting
        WHERE setting.tenant_id = attachment_row.tenant_id
          AND setting.key = 'portal.features'
          AND setting.value ->> 'clientInbox' = 'true'
          AND COALESCE(setting.value ->> 'documentUpload', 'true') <> 'false'
     ) THEN
    RAISE EXCEPTION 'Inbox-Recht, Mandantenzugriff und Uploadfeature erforderlich.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF attachment_row.message_id IS NULL
     OR attachment_row.scan_status <> 'CLEAN'
     OR attachment_row.decision <> 'PENDING_REVIEW'
     OR attachment_row.accepted_document_id IS NULL
     OR attachment_row.decided_by_staff_id IS NOT NULL
     OR attachment_row.decided_at IS NOT NULL
     OR attachment_row.rejection_reason IS NOT NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.portal_inbox_upload_batch batch
        WHERE batch.id = attachment_row.batch_id
          AND batch.tenant_id = attachment_row.tenant_id
          AND batch.client_id = attachment_row.client_id
          AND batch.status = 'CONSUMED'
     ) THEN
    RAISE EXCEPTION 'Inbox-Anlage besitzt keine abbrechbare PENDING-Reservierung.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT document.* INTO document_row
    FROM public.document document
   WHERE document.id = attachment_row.accepted_document_id
   FOR UPDATE;
  IF NOT FOUND
     OR document_row.tenant_id IS DISTINCT FROM attachment_row.tenant_id
     OR document_row.client_id IS DISTINCT FROM attachment_row.client_id
     OR document_row.deleted_at IS NOT NULL
     OR document_row.shared_with_client_at IS NOT NULL
     OR document_row.shared_by_staff IS NOT NULL
     OR document_row.gwg_destruction_requested_at IS NOT NULL
     OR document_row.gwg_destroyed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Reserviertes Inbox-Dokument ist nicht mehr abbrechbar.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*)::INTEGER INTO version_count
    FROM public.document_version version
   WHERE version.document_id = document_row.id;
  IF version_count <> 1 THEN
    RAISE EXCEPTION 'Reserviertes Inbox-Dokument muss genau eine Version besitzen.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT version.* INTO version_row
    FROM public.document_version version
   WHERE version.document_id = document_row.id
   FOR UPDATE;
  IF version_row.version_no <> 1
     OR version_row.scan_status <> 'PENDING'
     OR version_row.scan_completed_at IS NOT NULL
     OR version_row.storage_version_id IS NOT NULL
     OR version_row.sha256 IS DISTINCT FROM attachment_row.sha256
     OR version_row.size_bytes IS DISTINCT FROM attachment_row.size_bytes
     OR version_row.storage_key NOT LIKE
       'tenants/' || attachment_row.tenant_id::TEXT || '/%' THEN
    RAISE EXCEPTION 'Reservierte Inbox-Version stimmt nicht mit dem PENDING-Intent ueberein.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Derselbe feste Key darf nicht gleichzeitig auf mehrere Orphan-Identitaeten
  -- zeigen. Ein bereits vorhandener, exakt gleicher Nachweis kann idempotent
  -- weiterverwendet werden; jede Abweichung bleibt fail-closed.
  SELECT count(*)::INTEGER INTO orphan_count
    FROM public.storage_orphan orphan
   WHERE orphan.storage_bucket = version_row.storage_bucket
     AND orphan.storage_key = version_row.storage_key;
  IF orphan_count > 1 THEN
    RAISE EXCEPTION 'Mehrdeutiger Storage-Nachweis fuer reserviertes Inbox-Dokument.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF orphan_count = 1 THEN
    SELECT orphan.* INTO orphan_row
      FROM public.storage_orphan orphan
     WHERE orphan.storage_bucket = version_row.storage_bucket
       AND orphan.storage_key = version_row.storage_key
     FOR UPDATE;
    IF orphan_row.tenant_id IS DISTINCT FROM attachment_row.tenant_id
       OR orphan_row.sha256 IS DISTINCT FROM version_row.sha256
       OR orphan_row.size_bytes IS DISTINCT FROM version_row.size_bytes
       OR orphan_row.immutable IS DISTINCT FROM version_row.immutable
       OR orphan_row.retention_until IS DISTINCT FROM document_row.retention_until THEN
      RAISE EXCEPTION 'Abweichender Storage-Nachweis fuer reserviertes Inbox-Dokument.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    INSERT INTO public.storage_orphan (
      tenant_id,
      source,
      storage_bucket,
      storage_key,
      storage_version_id,
      sha256,
      size_bytes,
      immutable,
      retention_until,
      failure
    ) VALUES (
      attachment_row.tenant_id,
      'portal-inbox-acceptance-aborted',
      version_row.storage_bucket,
      version_row.storage_key,
      '',
      version_row.sha256,
      version_row.size_bytes,
      version_row.immutable,
      document_row.retention_until,
      'PORTAL_INBOX_PENDING_ACCEPTANCE_REJECTED'
    )
    RETURNING * INTO orphan_row;
  END IF;

  -- Die Immutable-Ausnahme ist zusaetzlich im Versionstrigger an die Owner-
  -- Identitaet genau dieser Funktion und dieselbe offene Attachment-Bindung
  -- gekoppelt. Ein frei gesetztes GUC allein kann die Loeschung nicht oeffnen.
  PERFORM set_config('app.portal_inbox_reject_document_id', document_row.id::TEXT, TRUE);
  DELETE FROM public.document_version
   WHERE id = version_row.id
     AND document_id = document_row.id;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Reservierte Inbox-Version konnte nicht atomar entfernt werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  UPDATE public.portal_inbox_attachment
     SET accepted_document_id = NULL,
         decision = 'REJECTED',
         rejection_reason = p_reason,
         decided_by_staff_id = app.current_actor_id(),
         decided_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
   WHERE id = attachment_row.id
     AND decision = 'PENDING_REVIEW'
     AND accepted_document_id = document_row.id;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Inbox-Ablehnung wurde gleichzeitig geaendert.'
      USING ERRCODE = 'serialization_failure';
  END IF;

  DELETE FROM public.document
   WHERE id = document_row.id
     AND tenant_id = attachment_row.tenant_id
     AND client_id = attachment_row.client_id
     AND shared_with_client_at IS NULL
     AND deleted_at IS NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'Leere Inbox-Reservierung konnte nicht atomar entfernt werden.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM set_config('app.portal_inbox_reject_document_id', '', TRUE);

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION app.reject_pending_portal_inbox_attachment(UUID, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reject_pending_portal_inbox_attachment(UUID, TEXT)
  TO taxtronik_app;

-- Bestehende GwG-Ausnahmen bleiben unveraendert. Neu ist nur der nachweislich
-- PENDING gebliebene Inbox-Intent derselben Attachment-/Tenant-/Client-/Hash-
-- Bindung; CLEAN- oder bereits anderweitig gebundene Versionen bleiben strikt
-- unveraenderlich.
CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
RETURNS TRIGGER AS $$
DECLARE
  authorized_document TEXT;
  discard_document TEXT;
  inbox_reject_document TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.immutable = TRUE) THEN
    IF (OLD.scan_status = 'PENDING'
        AND OLD.scan_completed_at IS NULL
        AND OLD.storage_version_id IS NULL
        AND NEW.scan_status = 'CLEAN'
        AND NEW.scan_completed_at IS NOT NULL
        AND NEW.storage_version_id IS NOT NULL
        AND btrim(NEW.storage_version_id) <> ''
        AND OLD.id IS NOT DISTINCT FROM NEW.id
        AND OLD.storage_bucket IS NOT DISTINCT FROM NEW.storage_bucket
        AND OLD.storage_key IS NOT DISTINCT FROM NEW.storage_key
        AND OLD.sha256 IS NOT DISTINCT FROM NEW.sha256
        AND OLD.size_bytes IS NOT DISTINCT FROM NEW.size_bytes
        AND OLD.immutable IS NOT DISTINCT FROM NEW.immutable
        AND OLD.version_no IS NOT DISTINCT FROM NEW.version_no
        AND OLD.document_id IS NOT DISTINCT FROM NEW.document_id
        AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
        AND OLD.created_by_id IS NOT DISTINCT FROM NEW.created_by_id) THEN
      RETURN NEW;
    END IF;

    IF (OLD.id IS DISTINCT FROM NEW.id
        OR OLD.storage_bucket IS DISTINCT FROM NEW.storage_bucket
        OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
        OR OLD.storage_version_id IS DISTINCT FROM NEW.storage_version_id
        OR OLD.sha256 IS DISTINCT FROM NEW.sha256
        OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
        OR OLD.immutable IS DISTINCT FROM NEW.immutable
        OR OLD.scan_status IS DISTINCT FROM NEW.scan_status
        OR OLD.scan_completed_at IS DISTINCT FROM NEW.scan_completed_at
        OR OLD.version_no IS DISTINCT FROM NEW.version_no
        OR OLD.document_id IS DISTINCT FROM NEW.document_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.created_by_id IS DISTINCT FROM NEW.created_by_id) THEN
      RAISE EXCEPTION 'document_version ist immutable, Inhaltsfelder duerfen nicht geaendert werden'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE' AND OLD.immutable = TRUE) THEN
    authorized_document := current_setting('app.gwg_destroy_document_id', TRUE);
    IF authorized_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure('app.destroy_gwg_document_versions(uuid)')
       )
       AND EXISTS (
         SELECT 1 FROM public.document document
          WHERE document.id = OLD.document_id
            AND document.classification = 'GWG_EVIDENCE'
            AND document.gwg_destruction_requested_at IS NOT NULL
            AND document.gwg_destroyed_at IS NULL
       ) THEN
      RETURN OLD;
    END IF;

    discard_document := current_setting('app.gwg_discard_document_id', TRUE);
    IF discard_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure(
            'app.discard_open_gwg_onboarding_document(uuid,uuid)'
          )
       )
       AND EXISTS (
         SELECT 1
           FROM public.document document
           JOIN public.gwg_onboarding_invite invite
             ON invite.id = document.gwg_onboarding_invite_id
          WHERE document.id = OLD.document_id
            AND document.classification = 'GWG_EVIDENCE'
            AND document.tenant_id = app.current_tenant_id()
            AND invite.status IN (
              'PENDING'::public.gwg_invite_status,
              'STARTED'::public.gwg_invite_status
            )
            AND invite.expires_at > CURRENT_TIMESTAMP
            AND NOT EXISTS (
              SELECT 1 FROM public.gwg_id_document id_document
               WHERE id_document.document_id = document.id
            )
       ) THEN
      RETURN OLD;
    END IF;

    inbox_reject_document := current_setting(
      'app.portal_inbox_reject_document_id',
      TRUE
    );
    IF inbox_reject_document = OLD.document_id::TEXT
       AND CURRENT_USER = (
         SELECT pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc p
          WHERE p.oid = pg_catalog.to_regprocedure(
            'app.reject_pending_portal_inbox_attachment(uuid,text)'
          )
       )
       AND OLD.scan_status = 'PENDING'
       AND OLD.scan_completed_at IS NULL
       AND OLD.storage_version_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM public.document document
           JOIN public.portal_inbox_attachment attachment
             ON attachment.accepted_document_id = document.id
          WHERE document.id = OLD.document_id
            AND document.tenant_id = app.current_tenant_id()
            AND document.client_id = attachment.client_id
            AND document.shared_with_client_at IS NULL
            AND document.shared_by_staff IS NULL
            AND document.deleted_at IS NULL
            AND attachment.tenant_id = document.tenant_id
            AND attachment.decision = 'PENDING_REVIEW'
            AND attachment.scan_status = 'CLEAN'
            AND attachment.message_id IS NOT NULL
            AND attachment.sha256 = OLD.sha256
            AND attachment.size_bytes = OLD.size_bytes
       ) THEN
      RETURN OLD;
    END IF;

    RAISE EXCEPTION 'document_version ist immutable und darf nicht geloescht werden'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION app.protect_immutable_document_version()
  SET search_path = pg_catalog, public, app, pg_temp;

