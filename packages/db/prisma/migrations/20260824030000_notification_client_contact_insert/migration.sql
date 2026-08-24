-- =============================================================================
-- CLIENT_CONTACT erzeugt ausschließlich write-only Mitarbeiterhinweise.
--
-- Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
--
-- Prisma `notification.create()` verwendet INSERT ... RETURNING. Da Portal-
-- Kontakte interne Staff-Notifications absichtlich nicht SELECTen dürfen,
-- verwirft PostgreSQL das RETURNING und damit bislang auch den zulässigen
-- INSERT. Die eng begrenzte Funktion führt den idempotenten Upsert ohne
-- Rückgabe der Notification-Zeile aus. SELECT-Zugriff für Portal-Kontakte wird
-- ausdrücklich nicht erweitert.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app.upsert_client_contact_notification(
  p_tenant_id UUID,
  p_client_id UUID,
  p_staff_id UUID,
  p_kind public."notification_kind",
  p_title TEXT,
  p_body TEXT,
  p_href TEXT,
  p_resource_type TEXT,
  p_resource_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
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
$$;

-- Die allgemeine INSERT-Policy bleibt Staff/System vorbehalten. Portal-
-- Kontakte schreiben ausschließlich durch die obige validierende Funktion;
-- damit lässt sich die Positivliste nicht per non-returning Raw-INSERT umgehen.
DROP POLICY "notification_insert" ON public."notification";

CREATE POLICY "notification_insert"
  ON public."notification"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = app.current_tenant_id()
    AND (
      app.current_actor_type() = 'SYSTEM'
      OR (
        app.current_actor_type() = 'STAFF'
        AND app.notification_staff_actor_is_active(
          "tenant_id",
          app.current_actor_id()
        )
        AND (
          (
            "client_id" IS NULL
            AND app.notification_neutral_scope_is_valid(
              "tenant_id",
              "resource_type",
              "resource_id"
            )
          )
          OR (
            app.notification_resource_matches_client(
              "tenant_id",
              "resource_type",
              "resource_id",
              "client_id"
            )
            AND app.notification_staff_can_access_client(
              "tenant_id",
              app.current_actor_id(),
              "client_id"
            )
          )
        )
      )
    )
  );

REVOKE ALL ON FUNCTION app.upsert_client_contact_notification(
  UUID,
  UUID,
  UUID,
  public."notification_kind",
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.upsert_client_contact_notification(
  UUID,
  UUID,
  UUID,
  public."notification_kind",
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  TEXT
) TO taxtronik_app;

COMMIT;
