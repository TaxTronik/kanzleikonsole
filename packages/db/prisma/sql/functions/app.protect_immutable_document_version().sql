CREATE OR REPLACE FUNCTION app.protect_immutable_document_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'app', 'pg_temp'
AS $function$
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
$function$;
