CREATE POLICY notification_portal_inbox_permission ON public.notification
  AS RESTRICTIVE
  FOR ALL
  TO taxtronik_app
  USING (((kind <> 'PORTAL_INBOX_ACTIVITY'::public.notification_kind) OR (app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (staff_id = app.current_actor_id()) AND (client_id IS NOT NULL) AND app.portal_inbox_staff_access(tenant_id, client_id))))
  WITH CHECK (((kind <> 'PORTAL_INBOX_ACTIVITY'::public.notification_kind) OR (app.current_actor_type() = 'SYSTEM'::text) OR ((app.current_actor_type() = 'STAFF'::text) AND (client_id IS NOT NULL) AND app.portal_inbox_staff_access(tenant_id, client_id))));
