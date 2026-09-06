-- PORTAL-INBOX-SUBMISSION-001 / ACCESS-NOTIFICATION-RECIPIENT-001
-- Forward-Härtung für mandantenweite Attachment-Sicht und den neuen,
-- weiterhin fail-closed klassifizierten Notification-Ressourcentyp.
BEGIN;

CREATE FUNCTION app.portal_inbox_consumed_batch(
  p_batch_id UUID,
  p_tenant_id UUID,
  p_client_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
  SELECT app.portal_inbox_contact_access(p_tenant_id, p_client_id)
    AND EXISTS (
      SELECT 1 FROM public.portal_inbox_upload_batch batch
      WHERE batch.id = p_batch_id
        AND batch.tenant_id = p_tenant_id
        AND batch.client_id = p_client_id
        AND batch.status = 'CONSUMED'
    )
$$;
REVOKE ALL ON FUNCTION app.portal_inbox_consumed_batch(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.portal_inbox_consumed_batch(UUID, UUID, UUID) TO taxtronik_app;

DROP POLICY portal_inbox_attachment_contact_select
  ON public.portal_inbox_attachment;
CREATE POLICY portal_inbox_attachment_contact_select
  ON public.portal_inbox_attachment
  FOR SELECT
  USING (
    (
      app.portal_inbox_owned_open_batch(batch_id)
    )
    OR (
      message_id IS NOT NULL
      AND scan_status = 'CLEAN'
      AND decision IN ('PENDING_REVIEW', 'ACCEPTED')
      AND app.portal_inbox_consumed_batch(batch_id, tenant_id, client_id)
    )
  );

CREATE FUNCTION app.notification_derive_portal_inbox_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  expected_client_id UUID;
  staff_tenant_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.staff_id IS DISTINCT FROM OLD.staff_id
    OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
  ) THEN
    RAISE EXCEPTION 'Notification-Scope und Ressourcenlink sind unveränderlich'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT thread.client_id INTO expected_client_id
    FROM public.portal_inbox_thread thread
   WHERE thread.tenant_id = NEW.tenant_id
     AND thread.id::TEXT = NEW.resource_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bekannte Notification-Ressource existiert nicht im Tenant-Scope (%:%)',
      NEW.resource_type, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.client_id IS NOT NULL AND NEW.client_id IS DISTINCT FROM expected_client_id THEN
    RAISE EXCEPTION 'Notification.client_id widerspricht dem bekannten Inbox-Thread'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.client_id := expected_client_id;

  IF NEW.staff_id IS NOT NULL THEN
    SELECT staff.tenant_id INTO staff_tenant_id
      FROM public.staff_user staff
     WHERE staff.id = NEW.staff_id
     FOR KEY SHARE;
    IF NOT FOUND OR staff_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Notification.staff_id gehört nicht zum Tenant-Scope'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER "00_notification_derive_client_scope" ON public.notification;
CREATE TRIGGER "00_notification_derive_client_scope"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id, resource_type, resource_id, staff_id
  ON public.notification
  FOR EACH ROW
  WHEN (NEW.resource_type IS DISTINCT FROM 'portal_inbox_thread')
  EXECUTE FUNCTION app.notification_derive_client_scope();
CREATE TRIGGER "00_notification_derive_portal_inbox_scope"
  BEFORE INSERT OR UPDATE OF tenant_id, client_id, resource_type, resource_id, staff_id
  ON public.notification
  FOR EACH ROW
  WHEN (NEW.resource_type IS NOT DISTINCT FROM 'portal_inbox_thread')
  EXECUTE FUNCTION app.notification_derive_portal_inbox_scope();

REVOKE ALL ON FUNCTION app.notification_derive_portal_inbox_scope()
  FROM PUBLIC, taxtronik_app;

COMMIT;
