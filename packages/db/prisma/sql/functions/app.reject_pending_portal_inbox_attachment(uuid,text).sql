CREATE OR REPLACE FUNCTION app.reject_pending_portal_inbox_attachment(p_attachment_id uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
 SET row_security TO 'off'
AS $function$
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
$function$;
