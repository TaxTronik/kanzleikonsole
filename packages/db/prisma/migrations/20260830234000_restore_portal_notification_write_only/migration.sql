-- Preserve the write-only portal notification contract after the late security
-- repair replays the older notification_insert policy on a fresh database.
-- Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001.
--
-- Historical migrations remain unchanged. The validating SECURITY DEFINER
-- function, its closed event allowlist and the SELECT/UPDATE/DELETE policies
-- remain unchanged; portal actors must not bypass that function via raw INSERT.
BEGIN;

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

COMMIT;
