CREATE POLICY tax_deadline_notification_history_select ON public.tax_deadline_notification_history
  AS PERMISSIVE
  FOR SELECT
  TO PUBLIC
  USING (((tenant_id = app.current_tenant_id()) AND (app.current_actor_type() = 'STAFF'::text) AND (EXISTS ( SELECT 1
   FROM (public.staff_user staff
     JOIN public.staff_role role ON ((role.staff_user_id = staff.id)))
  WHERE ((staff.id = app.current_actor_id()) AND (staff.tenant_id = tax_deadline_notification_history.tenant_id) AND (staff.active = true) AND (role.role = ANY (ARRAY['ADMIN'::public.staff_role_name, 'PARTNER'::public.staff_role_name])))))));
